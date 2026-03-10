const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

const API_ENDPOINTS = [{ url: 'https://f.sillydream.top', name: '官方稳定线路' }];
const DEFAULT_MODEL = '「Rim」gemini-3-pro-image-preview';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('.'));
app.use(session({
  secret: 'banana-ai-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

const upload = multer({ dest: 'uploads/', limits: { fileSize: 20 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) cb(null, true); else cb(new Error('只接受图片'));
}});

const db = new sqlite3.Database('./data.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE, password TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS configs (user_id INTEGER PRIMARY KEY, api_key TEXT, model TEXT DEFAULT '${DEFAULT_MODEL}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, user_id INTEGER, type TEXT, prompt TEXT, image_url TEXT, status TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  
  const hash = bcrypt.hashSync('admin123', 8);
  db.run(`INSERT OR IGNORE INTO users (id, email, password) VALUES (1, 'admin@banana.ai', ?)`, [hash]);
});

// 线路请求
async function tryEndpoints(apiKey, requestBody) {
  for (const ep of API_ENDPOINTS) {
    try {
      const res = await axios.post(`${ep.url}/v1/chat/completions`, requestBody, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 90000
      });
      return { success: true, data: res.data, endpoint: ep.name };
    } catch (e) {
      if (e.response?.status === 401) throw new Error('API Key 无效');
      continue;
    }
  }
  throw new Error('所有线路失败，请稍后重试或检查API Key');
}

// 认证中间件
const auth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  next();
};

// ==================== 完整路由实现 ====================
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (!user || !bcrypt.compareSync(password, user.password)) return res.json({ success: false, error: '邮箱或密码错误' });
    req.session.userId = user.id;
    res.json({ success: true, user: { id: user.id, email: user.email } });
  });
});

app.post('/api/register', (req, res) => {
  const { email, password } = req.body;
  const hash = bcrypt.hashSync(password, 8);
  db.run('INSERT INTO users (email, password) VALUES (?, ?)', [email, hash], function(err) {
    if (err) return res.json({ success: false, error: '邮箱已存在' });
    req.session.userId = this.lastID;
    res.json({ success: true });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', auth, (req, res) => {
  db.get('SELECT id, email FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    res.json(user);
  });
});

app.post('/api/config', auth, (req, res) => {
  const { api_key, model } = req.body;
  db.run('INSERT OR REPLACE INTO configs (user_id, api_key, model) VALUES (?, ?, ?)',
    [req.session.userId, api_key, model || DEFAULT_MODEL], () => res.json({ success: true }));
});

app.get('/api/config', auth, (req, res) => {
  db.get('SELECT * FROM configs WHERE user_id = ?', [req.session.userId], (err, row) => res.json(row || { model: DEFAULT_MODEL }));
});

app.get('/api/history', auth, (req, res) => {
  db.all('SELECT * FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT 30', [req.session.userId], (err, rows) => res.json(rows || []));
});

app.post('/api/img2img', auth, upload.array('images', 4), async (req, res) => {
  const { prompt } = req.body;
  const userId = req.session.userId;
  if (!req.files?.length) return res.status(400).json({ error: '请上传图片' });

  const config = await new Promise(r => db.get('SELECT * FROM configs WHERE user_id=?', [userId], (_, c) => r(c)));
  if (!config?.api_key) {
    req.files.forEach(f => fs.unlinkSync(f.path));
    return res.status(400).json({ error: '请先在设置中保存API Key' });
  }

  try {
    const imageContents = req.files.map(f => {
      const b64 = fs.readFileSync(f.path).toString('base64');
      fs.unlinkSync(f.path);
      return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } };
    });

    const body = {
      model: config.model || DEFAULT_MODEL,
      messages: [{ role: 'user', content: [...imageContents, { type: 'text', text: prompt || '根据参考图生成高质量新图像' }] }],
      max_tokens: 4096
    };

    const result = await tryEndpoints(config.api_key, body);
    const content = result.data.choices?.[0]?.message?.content || '';
    const imageUrl = content.match(/(https?:\/\/[^\s"<]+)/)?.[0];

    if (!imageUrl) throw new Error('未提取到图片URL');

    db.run('INSERT INTO history (user_id, type, prompt, image_url, status) VALUES (?, "img2img", ?, ?, "success")', [userId, prompt, imageUrl]);

    res.json({ success: true, image_url: imageUrl, endpoint: result.endpoint, model: config.model });
  } catch (e) {
    req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    res.status(500).json({ error: e.message || '生成失败', suggestion: '稍等1分钟或检查API Key' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NanoBanana2 AI 已启动！端口 ${PORT}`);
  console.log(`🌐 访问地址: http://localhost:${PORT}`);
});
