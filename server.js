const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 核心配置 ====================
app.set('trust proxy', 1);

// 上传目录
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('.'));
app.use('/uploads', express.static(uploadDir));

// Session配置（生产环境优化）
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'sessionId',
  cookie: { 
    secure: false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    path: '/'
  },
  rolling: true
}));

// ==================== 数据库配置 ====================
let DB_PATH = process.env.DB_PATH || './data.sqlite';
const dataDir = path.dirname(DB_PATH);

if (dataDir !== '.' && !fs.existsSync(dataDir)) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    DB_PATH = './data.sqlite';
  }
}

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
    process.exit(1);
  }
});

// ==================== 数据库初始化 ====================
function initDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // 用户表
      db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        email_verified INTEGER DEFAULT 1,
        role TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      // API配置表（严格用户隔离）
      db.run(`CREATE TABLE IF NOT EXISTS api_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        name TEXT NOT NULL,
        api_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        model TEXT DEFAULT 'dall-e-3',
        is_default INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);

      // 生成记录表（严格用户隔离）
      db.run(`CREATE TABLE IF NOT EXISTS generations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        prompt TEXT,
        image_url TEXT,
        size TEXT DEFAULT '1024x1024',
        type TEXT DEFAULT 'text2img',
        provider TEXT,
        status TEXT,
        error_msg TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);

      // 创建默认管理员
      const adminEmail = process.env.ADMIN_EMAIL || 'admin@banana.ai';
      const adminPass = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 8);
      
      db.run(`INSERT OR IGNORE INTO users (id, email, password, email_verified, role) 
              VALUES (1, ?, ?, 1, 'admin')`, [adminEmail, adminPass], function(err) {
        if (this.changes > 0) {
          console.log('✓ 管理员已创建:', adminEmail);
        }
        resolve();
      });
    });
  });
}

initDatabase().then(() => {
  console.log('✓ 数据库初始化完成');
}).catch(err => {
  console.error('✗ 初始化失败:', err);
  process.exit(1);
});

// ==================== 权限中间件 ====================
const requireAuth = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未登录' });
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: '无权限' });
  }
  next();
};

// ==================== 路由 ====================

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    user: req.session.userId || null,
    time: new Date().toISOString() 
  });
});

// 内置供应商
app.get('/api/providers', (req, res) => {
  res.json([
    {
      id: 't8star',
      name: '贞贞的AI工坊',
      description: '稳定的AI图像生成服务',
      website: 'https://ai.t8star.cn/login',
      baseUrl: 'https://ai.t8star.cn/v1/images/generations',
      models: ['nano-banana-2', 'gemini-2-5-flash-image-preview']
    },
    {
      id: 'sillydream',
      name: 'SillyDream',
      description: '高性价比的AI图像生成API',
      website: 'https://wish.sillydream.top/register?aff=iFev',
      baseUrl: 'https://wish.sillydream.top/v1/images/generations',
      models: ['dall-e-3', 'gpt-4o-image', 'midjourney-v6']
    }
  ]);
});

// ==================== 认证接口（简化版，无验证码） ====================

// 注册（无验证码）
app.post('/api/auth/register', (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !email.includes('@') || !password || password.length < 6) {
    return res.status(400).json({ error: '请输入有效邮箱和密码（至少6位）' });
  }
  
  db.get('SELECT id FROM users WHERE email = ?', [email], (err, existing) => {
    if (err) return res.status(500).json({ error: '系统错误' });
    if (existing) return res.status(400).json({ error: '该邮箱已被注册' });
    
    const hash = bcrypt.hashSync(password, 10);
    db.run('INSERT INTO users (email, password, email_verified) VALUES (?, ?, 1)', 
      [email, hash],
      function(err) {
        if (err) return res.status(500).json({ error: '注册失败' });
        res.json({ success: true, msg: '注册成功，请登录', userId: this.lastID });
      });
  });
});

// 登录
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: '请输入邮箱和密码' });
  }
  
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (err) return res.status(500).json({ error: '系统错误' });
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }
    
    req.session.userId = user.id;
    req.session.role = user.role;
    
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: '登录失败' });
      res.json({ success: true, role: user.role, userId: user.id });
    });
  });
});

// 退出
app.get('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: '退出失败' });
    res.clearCookie('sessionId');
    res.json({ success: true });
  });
});

// 获取当前用户
app.get('/api/user', requireAuth, (req, res) => {
  db.get('SELECT id, email, role, created_at FROM users WHERE id = ?', 
    [req.session.userId], (err, user) => {
      if (err || !user) return res.status(500).json({ error: '查询失败' });
      res.json(user);
    });
});

// ==================== API配置（严格用户隔离） ====================

// 获取我的API配置
app.get('/api/user/apis', requireAuth, (req, res) => {
  db.all('SELECT * FROM api_configs WHERE user_id = ? ORDER BY is_default DESC, created_at DESC', 
    [req.session.userId], (err, rows) => {
      if (err) return res.status(500).json({ error: '查询失败' });
      res.json(rows);
    });
});

// 添加API配置
app.post('/api/user/apis', requireAuth, (req, res) => {
  const { provider_id, name, api_url, api_key, model, is_default } = req.body;
  
  if (!name || !api_url || !api_key) {
    return res.status(400).json({ error: '请填写完整信息' });
  }
  
  const userId = req.session.userId;
  
  db.serialize(() => {
    if (is_default) {
      db.run('UPDATE api_configs SET is_default = 0 WHERE user_id = ?', [userId]);
    }
    
    db.run(`INSERT INTO api_configs (user_id, provider_id, name, api_url, api_key, model, is_default) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, provider_id || 'custom', name, api_url, api_key, model || 'dall-e-3', is_default ? 1 : 0],
      function(err) {
        if (err) return res.status(500).json({ error: '保存失败' });
        res.json({ success: true, id: this.lastID });
      });
  });
});

// 更新API配置
app.put('/api/user/apis/:id', requireAuth, (req, res) => {
  const { name, api_url, api_key, model, is_default } = req.body;
  const userId = req.session.userId;
  
  db.serialize(() => {
    if (is_default) {
      db.run('UPDATE api_configs SET is_default = 0 WHERE user_id = ?', [userId]);
    }
    
    db.run(`UPDATE api_configs SET name = ?, api_url = ?, api_key = ?, model = ?, is_default = ? 
            WHERE id = ? AND user_id = ?`,
      [name, api_url, api_key, model, is_default ? 1 : 0, req.params.id, userId],
      function(err) {
        if (err) return res.status(500).json({ error: '更新失败' });
        if (this.changes === 0) return res.status(403).json({ error: '无权修改' });
        res.json({ success: true });
      });
  });
});

// 删除API配置
app.delete('/api/user/apis/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM api_configs WHERE id = ? AND user_id = ?', 
    [req.params.id, req.session.userId],
    function(err) {
      if (err) return res.status(500).json({ error: '删除失败' });
      if (this.changes === 0) return res.status(403).json({ error: '无权删除' });
      res.json({ success: true });
    });
});

// 获取默认配置
app.get('/api/user/apis/default', requireAuth, (req, res) => {
  db.get('SELECT * FROM api_configs WHERE user_id = ? AND is_default = 1 LIMIT 1',
    [req.session.userId], (err, row) => {
      if (err) return res.status(500).json({ error: '查询失败' });
      if (!row) return res.status(404).json({ error: '未配置默认API' });
      res.json(row);
    });
});

// ==================== 图像生成（严格用户隔离） ====================

// 文生图
app.post('/api/generate', requireAuth, async (req, res) => {
  const { prompt, size = '1024x1024' } = req.body;
  const userId = req.session.userId;
  
  const config = await new Promise((resolve) => {
    db.get('SELECT * FROM api_configs WHERE user_id = ? AND is_default = 1 LIMIT 1',
      [userId], (err, row) => resolve(row));
  });
  
  if (!config) return res.status(400).json({ error: '请先配置默认API' });
  if (!config.api_key) return res.status(400).json({ error: 'API Key为空' });
  
  try {
    const response = await axios.post(
      config.api_url,
      {
        model: config.model || 'dall-e-3',
        prompt: prompt,
        n: 1,
        size: size
      },
      {
        headers: {
          'Authorization': `Bearer ${config.api_key}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000
      }
    );
    
    const imageUrl = response.data.data?.[0]?.url;
    
    db.run('INSERT INTO generations (user_id, prompt, image_url, size, type, provider, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, prompt, imageUrl, size, 'text2img', config.name, 'success']);
    
    res.json({ success: true, image_url: imageUrl, size });
  } catch (error) {
    const errorMsg = error.response?.data?.error?.message || error.message;
    db.run('INSERT INTO generations (user_id, prompt, size, type, status, error_msg) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, prompt, size, 'text2img', 'failed', errorMsg]);
    res.status(500).json({ error: '生成失败', detail: errorMsg });
  }
});

// 图生图
app.post('/api/img2img', requireAuth, upload.single('image'), async (req, res) => {
  const { prompt, size = '1024x1024' } = req.body;
  const userId = req.session.userId;
  
  const config = await new Promise((resolve) => {
    db.get('SELECT * FROM api_configs WHERE user_id = ? AND is_default = 1 LIMIT 1',
      [userId], (err, row) => resolve(row));
  });
  
  if (!config || !config.api_key) {
    if (req.file) fs.unlinkSync(path.join(__dirname, req.file.path));
    return res.status(400).json({ error: '请先配置API' });
  }
  
  try {
    const formData = new FormData();
    formData.append('image', fs.createReadStream(path.join(__dirname, req.file.path)));
    formData.append('prompt', prompt);
    formData.append('size', size);
    
    const response = await axios.post(
      config.api_url.replace('/generations', '/edits'),
      formData,
      {
        headers: {
          'Authorization': `Bearer ${config.api_key}`,
          ...formData.getHeaders()
        },
        timeout: 120000
      }
    );
    
    const imageUrl = response.data.data?.[0]?.url;
    fs.unlinkSync(path.join(__dirname, req.file.path));
    
    db.run('INSERT INTO generations (user_id, prompt, image_url, size, type, provider, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, prompt, imageUrl, size, 'img2img', config.name, 'success']);
    
    res.json({ success: true, image_url: imageUrl });
  } catch (error) {
    if (req.file) fs.unlinkSync(path.join(__dirname, req.file.path));
    res.status(500).json({ error: '生成失败', detail: error.message });
  }
});

// 多图参考
app.post('/api/multi-ref', requireAuth, upload.array('images', 4), async (req, res) => {
  const { prompt, size = '1024x1024' } = req.body;
  const userId = req.session.userId;
  
  const config = await new Promise((resolve) => {
    db.get('SELECT * FROM api_configs WHERE user_id = ? AND is_default = 1 LIMIT 1',
      [userId], (err, row) => resolve(row));
  });
  
  if (!config || !config.api_key) {
    req.files?.forEach(file => fs.unlinkSync(path.join(__dirname, file.path)));
    return res.status(400).json({ error: '请先配置API' });
  }
  
  try {
    const formData = new FormData();
    req.files.forEach(file => {
      formData.append('images', fs.createReadStream(path.join(__dirname, file.path)));
    });
    formData.append('prompt', prompt);
    formData.append('size', size);
    
    const response = await axios.post(
      config.api_url.replace('/generations', '/variations'),
      formData,
      {
        headers: {
          'Authorization': `Bearer ${config.api_key}`,
          ...formData.getHeaders()
        },
        timeout: 120000
      }
    );
    
    const imageUrl = response.data.data?.[0]?.url;
    req.files.forEach(file => fs.unlinkSync(path.join(__dirname, file.path)));
    
    db.run('INSERT INTO generations (user_id, prompt, image_url, size, type, provider, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, prompt, imageUrl, size, 'multi-ref', config.name, 'success']);
    
    res.json({ success: true, image_url: imageUrl });
  } catch (error) {
    req.files?.forEach(file => {
      try { fs.unlinkSync(path.join(__dirname, file.path)); } catch(e) {}
    });
    res.status(500).json({ error: '生成失败', detail: error.message });
  }
});

// ==================== 历史记录（严格用户隔离） ====================

app.get('/api/history', requireAuth, (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  
  db.all('SELECT * FROM generations WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [req.session.userId, parseInt(limit), parseInt(offset)],
    (err, rows) => {
      if (err) return res.status(500).json({ error: '查询失败' });
      res.json(rows);
    });
});

app.delete('/api/history/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM generations WHERE id = ? AND user_id = ?', 
    [req.params.id, req.session.userId],
    function(err) {
      if (err) return res.status(500).json({ error: '删除失败' });
      if (this.changes === 0) return res.status(403).json({ error: '无权删除' });
      res.json({ success: true });
    });
});

// ==================== 管理员接口 ====================

app.get('/api/admin/users', requireAdmin, (req, res) => {
  db.all(`SELECT u.id, u.email, u.role, u.created_at, COUNT(g.id) as total_generations
          FROM users u LEFT JOIN generations g ON u.id = g.user_id
          GROUP BY u.id ORDER BY u.id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: '查询失败' });
    res.json(rows);
  });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  db.get('SELECT COUNT(*) as total_users FROM users', [], (err, u) => {
    db.get('SELECT COUNT(*) as total_gens FROM generations', [], (err, g) => {
      db.get(`SELECT COUNT(*) as today_gens FROM generations 
              WHERE date(created_at) = date('now')`, [], (err, t) => {
        res.json({
          total_users: u?.total_users || 0,
          total_generations: g?.total_gens || 0,
          today_generations: t?.today_gens || 0
        });
      });
    });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🍌 服务器运行在端口 ${PORT}`);
});
