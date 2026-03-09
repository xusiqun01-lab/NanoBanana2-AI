const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 核心配置 ====================
app.set('trust proxy', 1);

// 关键修复：CORS必须允许credentials
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// 上传目录
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer配置（内存存储，避免磁盘IO延迟）
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('.'));
app.use('/uploads', express.static(uploadDir));

// Session配置（关键：sameSite和secure根据环境调整）
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'sessionId',
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  }
}));

// ==================== 数据库 ====================
const db = new sqlite3.Database(process.env.DB_PATH || './data.sqlite');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS api_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    api_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT DEFAULT 'dall-e-3',
    is_default INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    prompt TEXT,
    image_url TEXT,
    size TEXT,
    type TEXT,
    provider TEXT,
    status TEXT,
    error_msg TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@banana.ai';
  const adminPass = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 8);
  db.run(`INSERT OR IGNORE INTO users (id, email, password, role) 
          VALUES (1, ?, ?, 'admin')`, [adminEmail, adminPass]);
});

// ==================== 权限中间件 ====================
const requireAuth = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未登录', code: 'AUTH_REQUIRED' });
  }
  next();
};

// ==================== 辅助函数 ====================

// 记录生成日志（调试用）
function logGeneration(type, status, details) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${type}] ${status}:`, details);
}

// 统一错误处理
function handleApiError(error, res) {
  let errorMsg = '未知错误';
  let errorDetail = '';
  
  if (error.response) {
    // API返回了错误响应
    errorMsg = error.response.data?.error?.message || 
               error.response.data?.message || 
               `HTTP ${error.response.status}`;
    errorDetail = JSON.stringify(error.response.data);
    console.error('API错误响应:', error.response.status, error.response.data);
  } else if (error.request) {
    // 请求发出但没有收到响应
    errorMsg = '无法连接到API服务器，请检查网络或URL配置';
    console.error('网络错误:', error.message);
  } else {
    // 其他错误
    errorMsg = error.message;
    console.error('处理错误:', error);
  }
  
  return { error: errorMsg, detail: errorDetail };
}

// ==================== 文生图（修复版）====================
app.post('/api/generate', requireAuth, async (req, res) => {
  const { prompt, size = '1024x1024' } = req.body;
  const userId = req.session.userId;
  
  logGeneration('text2img', 'START', { userId, prompt: prompt?.substring(0, 50), size });
  
  if (!prompt || prompt.trim().length === 0) {
    return res.status(400).json({ error: '提示词不能为空' });
  }
  
  const config = await new Promise((resolve) => {
    db.get('SELECT * FROM api_configs WHERE user_id = ? AND is_default = 1 LIMIT 1',
      [userId], (err, row) => resolve(row));
  });
  
  if (!config) {
    return res.status(400).json({ error: '未配置默认API', solution: '请先到API设置页面添加配置' });
  }
  
  try {
    const requestBody = {
      model: config.model || 'dall-e-3',
      prompt: prompt.trim(),
      n: 1,
      size: size,
      response_format: 'url'  // 关键：强制要求返回URL
    };
    
    console.log(`[文生图] 请求URL: ${config.api_url}`);
    console.log(`[文生图] 请求体:`, JSON.stringify(requestBody, null, 2));
    
    const response = await axios.post(
      config.api_url,
      requestBody,
      {
        headers: {
          'Authorization': `Bearer ${config.api_key}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 120000, // 2分钟超时
        validateStatus: (status) => true // 让 axios 不抛出HTTP错误，我们自己处理
      }
    );
    
    console.log(`[文生图] 响应状态: ${response.status}`);
    console.log(`[文生图] 响应数据:`, JSON.stringify(response.data, null, 2));
    
    if (response.status !== 200) {
      throw new Error(`API返回错误: ${response.data?.error?.message || response.statusText}`);
    }
    
    // 解析图片URL（支持多种格式）
    let imageUrl = null;
    
    // OpenAI标准格式
    if (response.data.data && Array.isArray(response.data.data) && response.data.data[0]) {
      imageUrl = response.data.data[0].url || response.data.data[0].b64_json;
    }
    // 直接返回URL
    else if (response.data.url) {
      imageUrl = response.data.url;
    }
    // 其他可能的格式
    else if (response.data.image_url) {
      imageUrl = response.data.image_url;
    }
    else if (response.data.images && response.data.images[0]) {
      imageUrl = response.data.images[0];
    }
    
    if (!imageUrl) {
      throw new Error(`无法解析API响应，返回数据结构: ${Object.keys(response.data).join(', ')}`);
    }
    
    // 保存记录
    db.run('INSERT INTO generations (user_id, prompt, image_url, size, type, provider, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, prompt, imageUrl, size, 'text2img', config.name, 'success']);
    
    logGeneration('text2img', 'SUCCESS', { imageUrl: imageUrl?.substring(0, 50) });
    res.json({ success: true, image_url: imageUrl });
    
  } catch (error) {
    const { error: errorMsg, detail } = handleApiError(error);
    logGeneration('text2img', 'FAILED', { error: errorMsg, detail });
    
    db.run('INSERT INTO generations (user_id, prompt, size, type, status, error_msg) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, prompt, size, 'text2img', 'failed', errorMsg + ' | ' + detail]);
    
    res.status(500).json({ 
      error: errorMsg, 
      detail: detail,
      tip: '常见问题：1. API Key错误 2. 余额不足 3. 模型名称错误 4. 网络超时'
    });
  }
});

// ==================== 图生图（核心修复版）====================
app.post('/api/img2img', requireAuth, upload.single('image'), async (req, res) => {
  const { prompt, size = '1024x1024' } = req.body;
  const userId = req.session.userId;
  
  logGeneration('img2img', 'START', { userId, hasImage: !!req.file, size });
  
  if (!req.file) {
    return res.status(400).json({ error: '未上传图片' });
  }
  
  const config = await new Promise((resolve) => {
    db.get('SELECT * FROM api_configs WHERE user_id = ? AND is_default = 1 LIMIT 1',
      [userId], (err, row) => resolve(row));
  });
  
  if (!config) {
    return res.status(400).json({ error: '未配置默认API' });
  }
  
  try {
    // 将图片转为Base64（兼容性最好）
    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/png';
    const dataUri = `data:${mimeType};base64,${base64Image}`;
    
    console.log(`[图生图] 图片大小: ${req.file.size} bytes, 类型: ${mimeType}`);
    
    // 策略1：尝试使用标准的 images/edits 端点（OpenAI标准）
    const editsUrl = config.api_url.replace('/generations', '/edits');
    
    const requestBody = {
      model: config.model || 'dall-e-2', // 图生图通常用dall-e-2
      image: dataUri,  // 关键：直接传base64
      prompt: prompt || 'transform this image',
      n: 1,
      size: size,
      response_format: 'url'
    };
    
    console.log(`[图生图] 尝试端点: ${editsUrl}`);
    console.log(`[图生图] 请求体大小: ${JSON.stringify(requestBody).length} bytes`);
    
    let response;
    let usedEndpoint = 'edits';
    
    try {
      response = await axios.post(
        editsUrl,
        requestBody,
        {
          headers: {
            'Authorization': `Bearer ${config.api_key}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 120000,
          maxBodyLength: Infinity,
          maxContentLength: Infinity
        }
      );
    } catch (editError) {
      console.log(`[图生图] edits端点失败，尝试generations端点...`);
      usedEndpoint = 'generations';
      
      // 策略2：某些平台（如部分国产API）使用generations端点但支持image参数
      response = await axios.post(
        config.api_url,
        {
          ...requestBody,
          model: config.model || 'dall-e-3' // 某些平台要求用dall-e-3
        },
        {
          headers: {
            'Authorization': `Bearer ${config.api_key}`,
            'Content-Type': 'application/json'
          },
          timeout: 120000,
          maxBodyLength: Infinity,
          maxContentLength: Infinity
        }
      );
    }
    
    console.log(`[图生图] 使用端点: ${usedEndpoint}, 状态: ${response.status}`);
    
    if (response.status !== 200) {
      throw new Error(`API错误: ${response.data?.error?.message || response.statusText}`);
    }
    
    // 解析结果（与文生图相同）
    let imageUrl = null;
    if (response.data.data && response.data.data[0]) {
      imageUrl = response.data.data[0].url || response.data.data[0].b64_json;
    } else if (response.data.url) {
      imageUrl = response.data.url;
    } else if (response.data.image_url) {
      imageUrl = response.data.image_url;
    }
    
    if (!imageUrl) {
      throw new Error(`无法解析响应: ${JSON.stringify(response.data)}`);
    }
    
    db.run('INSERT INTO generations (user_id, prompt, image_url, size, type, provider, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, prompt, imageUrl, size, 'img2img', config.name, 'success']);
    
    logGeneration('img2img', 'SUCCESS', { endpoint: usedEndpoint });
    res.json({ success: true, image_url: imageUrl, endpoint: usedEndpoint });
    
  } catch (error) {
    const { error: errorMsg, detail } = handleApiError(error);
    logGeneration('img2img', 'FAILED', { error: errorMsg });
    
    db.run('INSERT INTO generations (user_id, prompt, size, type, status, error_msg) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, prompt, size, 'img2img', 'failed', errorMsg]);
    
    res.status(500).json({ 
      error: errorMsg, 
      detail: detail,
      tip: '图生图失败常见原因：1. API不支持图生图 2. 图片格式错误 3. 图片过大 4. 模型不支持图像输入'
    });
  }
});

// ==================== API测试接口（调试用）====================
app.post('/api/test-connection', requireAuth, async (req, res) => {
  const { api_url, api_key, model } = req.body;
  
  try {
    // 测试文生图最小请求
    const testBody = {
      model: model || 'dall-e-3',
      prompt: 'test',
      n: 1,
      size: '1024x1024'
    };
    
    const response = await axios.post(
      api_url,
      testBody,
      {
        headers: {
          'Authorization': `Bearer ${api_key}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000,
        validateStatus: () => true
      }
    );
    
    res.json({
      status: response.status,
      statusText: response.statusText,
      data: response.data,
      headers: response.headers,
      suggestion: response.status === 200 ? '连接正常' : '检查API密钥或模型名称'
    });
    
  } catch (error) {
    res.json({
      error: error.message,
      code: error.code,
      suggestion: '检查URL是否正确，网络是否通畅'
    });
  }
});

// ==================== 其他路由（保持简洁）====================

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.save(() => {
      res.json({ success: true, role: user.role, email: user.email });
    });
  });
});

app.post('/api/auth/register', (req, res) => {
  const { email, password } = req.body;
  const hash = bcrypt.hashSync(password, 10);
  db.run('INSERT INTO users (email, password) VALUES (?, ?)', [email, hash], function(err) {
    if (err) return res.status(400).json({ error: '邮箱已存在' });
    res.json({ success: true });
  });
});

app.get('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/user', requireAuth, (req, res) => {
  db.get('SELECT id, email, role FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    res.json(user);
  });
});

app.get('/api/user/apis', requireAuth, (req, res) => {
  db.all('SELECT * FROM api_configs WHERE user_id = ? ORDER BY is_default DESC', [req.session.userId], (err, rows) => {
    res.json(rows);
  });
});

app.post('/api/user/apis', requireAuth, (req, res) => {
  const { name, api_url, api_key, model } = req.body;
  const userId = req.session.userId;
  
  db.serialize(() => {
    db.run('UPDATE api_configs SET is_default = 0 WHERE user_id = ?', [userId]);
    db.run('INSERT INTO api_configs (user_id, name, api_url, api_key, model, is_default) VALUES (?, ?, ?, ?, ?, 1)',
      [userId, name, api_url, api_key, model || 'dall-e-3'],
      function(err) {
        if (err) return res.status(500).json({ error: '保存失败' });
        res.json({ success: true, id: this.lastID });
      });
  });
});

app.get('/api/history', requireAuth, (req, res) => {
  db.all('SELECT * FROM generations WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
    [req.session.userId], (err, rows) => {
      res.json(rows);
    });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🍌 服务器运行在端口 ${PORT}`);
  console.log(`💡 调试提示：如果生成失败，检查API日志`);
});
