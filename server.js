const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;

// ==================== 配置（官方稳定线路）===================
const API_ENDPOINTS = [
  { url: 'https://f.sillydream.top', name: '官方稳定线路' }
];

const DEFAULT_MODEL = '「Rim」gemini-3-pro-image-preview';

// ==================== 中间件 ====================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('.'));
app.use(session({
  secret: 'banana-ai-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('只接受图片'));
  }
});

// ==================== 数据库 ====================
const db = new sqlite3.Database('./data.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    api_key TEXT,
    model TEXT DEFAULT '「Rim」gemini-3-pro-image-preview',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type TEXT,
    prompt TEXT,
    image_url TEXT,
    status TEXT,
    error_msg TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 默认管理员
  const hash = bcrypt.hashSync('admin123', 8);
  db.run(`INSERT OR IGNORE INTO users (id, email, password) VALUES (1, 'admin@banana.ai', ?)`, [hash]);
});

// ==================== 三线路切换（现在只有官方线路）===================
async function tryEndpoints(apiKey, requestBody, type = 'chat') {
  for (const endpoint of API_ENDPOINTS) {
    const url = type === 'chat'
      ? `${endpoint.url}/v1/chat/completions`
      : `${endpoint.url}/v1/images/generations`;

    try {
      console.log(`[尝试] ${endpoint.name}: ${url}`);
      const response = await axios.post(url, requestBody, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 90000
      });
      console.log(`[成功] 使用线路: ${endpoint.name}`);
      return { success: true, data: response.data, endpoint: endpoint.name };
    } catch (error) {
      const msg = error.response?.data?.error?.message || error.message;
      console.error(`[失败] ${endpoint.name}: ${msg}`);
      if (error.response?.status === 401) throw new Error('API Key 无效');
      continue;
    }
  }
  throw new Error('所有线路均失败（官方线路也失败时请检查API Key或稍后重试）');
}

// ==================== 认证中间件 ====================
const auth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  next();
};

// ==================== 路由 ====================

// 登录
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (err || !user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }
    req.session.userId = user.id;
    res.json({ success: true, user: { id: user.id, email: user.email } });
  });
});

// 注册
app.post('/api/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: '信息不完整' });
  }
  const hash = bcrypt.hashSync(password, 10);
  db.run('INSERT INTO users (email, password) VALUES (?, ?)', [email, hash], function(err) {
    if (err) return res.status(400).json({ error: '邮箱已存在' });
    res.json({ success: true });
  });
});

// 退出
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// 获取用户信息
app.get('/api/me', auth, (req, res) => {
  db.get('SELECT id, email FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    res.json(user);
  });
});

// 保存API配置（支持 model）
app.post('/api/config', auth, (req, res) => {
  const { api_key, model } = req.body;
  if (!api_key) return res.status(400).json({ error: '缺少API Key' });
  
  db.run('INSERT OR REPLACE INTO configs (user_id, api_key, model) VALUES (?, ?, ?)',
    [req.session.userId, api_key, model || DEFAULT_MODEL],
    (err) => {
      if (err) return res.status(500).json({ error: '保存失败' });
      res.json({ success: true });
    }
  );
});

// 获取配置
app.get('/api/config', auth, (req, res) => {
  db.get('SELECT * FROM configs WHERE user_id = ?', [req.session.userId], (err, config) => {
    res.json(config || { model: DEFAULT_MODEL });
  });
});

// 核心：图生图
app.post('/api/img2img', auth, upload.array('images', 4), async (req, res) => {
  const userId = req.session.userId;
  const { prompt } = req.body;
  
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: '请上传图片' });
  }

  const config = await new Promise((resolve) => {
    db.get('SELECT * FROM configs WHERE user_id = ?', [userId], (err, row) => resolve(row));
  });

  if (!config || !config.api_key) {
    req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    return res.status(400).json({ error: '请先设置API Key' });
  }

  const selectedModel = config.model || DEFAULT_MODEL;

  try {
    const imageContents = req.files.map(file => {
      const buffer = fs.readFileSync(file.path);
      const base64 = buffer.toString('base64');
      fs.unlinkSync(file.path);
      return {
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${base64}` }
      };
    });

    const requestBody = {
      model: selectedModel,
      messages: [{
        role: 'user',
        content: [
          ...imageContents,
          { type: 'text', text: prompt || '根据参考图生成新图像' }
        ]
      }],
      max_tokens: 4096,
      temperature: 0.8
    };

    console.log('[图生图] 开始请求，模型:', selectedModel);

    const result = await tryEndpoints(config.api_key, requestBody, 'chat');

    const content = result.data.choices?.[0]?.message?.content || '';
    let imageUrl = null;
    const mdMatch = content.match(/!\[.*?\]\((https?:\/\/[^\)]+)\)/);
    if (mdMatch) imageUrl = mdMatch[1];
    else {
      const urlMatch = content.match(/(https?:\/\/[^\s"<]+)/);
      if (urlMatch) imageUrl = urlMatch[0];
    }

    if (!imageUrl) throw new Error('未提取到图片URL（可能是白图）');

    db.run('INSERT INTO history (user_id, type, prompt, image_url, status) VALUES (?, ?, ?, ?, ?)',
      [userId, 'img2img', prompt, imageUrl, 'success']);

    res.json({
      success: true,
      image_url: imageUrl,
      endpoint: result.endpoint,
      model: selectedModel
    });

  } catch (error) {
    req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    db.run('INSERT INTO history (user_id, type, prompt, status, error_msg) VALUES (?, ?, ?, ?, ?)',
      [userId, 'img2img', prompt, 'failed', error.message]);

    res.status(500).json({
      error: '生成失败',
      detail: error.message,
      suggestion: '1. 服务器拥挤导致白图 → 稍等1-2分钟重试\n2. API Key 请从 https://wish.sillydream.top/console/token 获取\n3. 推荐使用2K模型（白图率更低）'
    });
  }
});

// 文生图（备用）
app.post('/api/text2img', auth, async (req, res) => {
  const { prompt } = req.body;
  const userId = req.session.userId;
  
  const config = await new Promise((resolve) => {
    db.get('SELECT * FROM configs WHERE user_id = ?', [userId], (err, row) => resolve(row));
  });
  
  if (!config || !config.api_key) {
    return res.status(400).json({ error: '未配置API Key' });
  }

  try {
    const requestBody = {
      model: config.model || DEFAULT_MODEL,
      prompt: prompt,
      n: 1,
      size: '1024x1024'
    };
    
    const result = await tryEndpoints(config.api_key, requestBody, 'generations');
    const imageUrl = result.data.data?.[0]?.url;
    if (!imageUrl) throw new Error('未获取到图片URL');
    
    db.run('INSERT INTO history (user_id, type, prompt, image_url, status) VALUES (?, ?, ?, ?, ?)',
      [userId, 'text2img', prompt, imageUrl, 'success']);
    
    res.json({ success: true, image_url: imageUrl, endpoint: result.endpoint });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取历史记录
app.get('/api/history', auth, (req, res) => {
  db.all('SELECT * FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', 
    [req.session.userId], (err, rows) => {
      res.json(rows || []);
    });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`🍌 香蕉AI v2.2 运行在端口 ${PORT}`);
  console.log(`📡 使用官方稳定线路: https://f.sillydream.top`);
  console.log(`🤖 默认模型: ${DEFAULT_MODEL}`);
});
