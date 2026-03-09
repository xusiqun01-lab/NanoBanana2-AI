const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

// 确保上传目录存在
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// 配置 multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
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

// Session 配置（生产环境安全）
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// 数据库路径（Railway 持久化卷）
const DB_PATH = process.env.DB_PATH || '/data/data.sqlite';
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);

// 邮件配置
const SMTP_CONFIG = {
  host: process.env.SMTP_HOST || 'smtp.163.com',
  port: parseInt(process.env.SMTP_PORT) || 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
};

const mailTransporter = SMTP_CONFIG.auth.user ? nodemailer.createTransport(SMTP_CONFIG) : null;

// 内置API供应商配置
const BUILT_IN_PROVIDERS = [
  {
    id: 't8star',
    name: '贞贞的AI工坊',
    description: '稳定的AI图像生成服务',
    website: 'https://ai.t8star.cn/login',
    baseUrl: 'https://ai.t8star.cn/v1/images/generations',
    models: ['nano-banana-2', 'gemini-2-5-flash-image-preview'],
    docs: 'https://ai.t8star.cn'
  },
  {
    id: 'sillydream',
    name: 'SillyDream',
    description: '高性价比的AI图像生成API',
    website: 'https://wish.sillydream.top/register?aff=iFev',
    baseUrl: 'https://wish.sillydream.top/v1/images/generations',
    models: ['dall-e-3', 'gpt-4o-image', 'midjourney-v6'],
    docs: 'https://wish.sillydream.top/docs'
  }
];

// ========== 数据库强制初始化函数 ==========
function initDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // 用户表
      db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        email_verified INTEGER DEFAULT 0,
        verification_token TEXT,
        role TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) console.error('创建用户表失败:', err);
        else console.log('✓ 用户表已就绪');
      });

      // API配置表
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
        FOREIGN KEY(user_id) REFERENCES users(id)
      )`, (err) => {
        if (err) console.error('创建API配置表失败:', err);
        else console.log('✓ API配置表已就绪');
      });

      // 邮箱验证表
      db.run(`CREATE TABLE IF NOT EXISTS email_verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        code TEXT NOT NULL,
        type TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        used INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) console.error('创建验证表失败:', err);
        else console.log('✓ 验证表已就绪');
      });

      // 生成记录表
      db.run(`CREATE TABLE IF NOT EXISTS generations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        prompt TEXT,
        image_url TEXT,
        size TEXT DEFAULT '1024x1024',
        type TEXT DEFAULT 'text2img',
        provider TEXT,
        status TEXT,
        error_msg TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )`, (err) => {
        if (err) console.error('创建记录表失败:', err);
        else console.log('✓ 生成记录表已就绪');
      });

      // 创建默认管理员（使用环境变量或默认值）
      const adminEmail = process.env.ADMIN_EMAIL || 'admin@banana.ai';
      const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
      const adminPass = bcrypt.hashSync(adminPassword, 8);
      
      db.run(`INSERT OR IGNORE INTO users (id, email, password, email_verified, role) 
              VALUES (1, ?, ?, 1, 'admin')`, [adminEmail, adminPass], function(err) {
        if (err) {
          console.error('创建管理员失败:', err);
        } else {
          if (this.changes > 0) {
            console.log('✓ 默认管理员已创建:', adminEmail);
          } else {
            console.log('✓ 管理员已存在');
          }
        }
        // 初始化完成
        resolve();
      });
    });
  });
}

// 立即执行初始化
initDatabase().then(() => {
  console.log('数据库初始化完成');
}).catch(err => {
  console.error('数据库初始化失败:', err);
});

// 中间件
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session.userId || req.session.role !== 'admin') 
    return res.status(403).json({ error: '无权限' });
  next();
};

// 发送邮件函数
async function sendEmail(to, subject, html) {
  if (!mailTransporter) {
    console.log(`[邮件模拟] 发送到: ${to}\n主题: ${subject}\n内容: ${html}`);
    return { success: true, preview: true };
  }
  
  try {
    await mailTransporter.sendMail({
      from: `"香蕉AI" <${SMTP_CONFIG.auth.user}>`,
      to,
      subject,
      html
    });
    return { success: true };
  } catch (error) {
    console.error('邮件发送失败:', error);
    return { success: false, error: error.message };
  }
}

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

setInterval(() => {
  db.run(`DELETE FROM email_verifications WHERE expires_at < datetime('now') OR used = 1`);
}, 3600000);

// 根路径
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 健康检查（Railway需要）
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    db: fs.existsSync(DB_PATH) ? 'connected' : 'disconnected',
    time: new Date().toISOString() 
  });
});

// 获取内置供应商列表
app.get('/api/providers', (req, res) => {
  res.json(BUILT_IN_PROVIDERS);
});

// 发送注册验证码
app.post('/api/auth/send-code', async (req, res) => {
  const { email, type = 'register' } = req.body;
  
  if (!email || !email.includes('@')) {
    return res.json({ error: '请输入有效的邮箱地址' });
  }
  
  if (type === 'register') {
    const existing = await new Promise((resolve) => {
      db.get('SELECT id FROM users WHERE email = ?', [email], (err, row) => resolve(row));
    });
    if (existing) return res.json({ error: '该邮箱已被注册' });
  }
  
  const code = generateCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  
  db.run(`INSERT INTO email_verifications (email, code, type, expires_at) VALUES (?, ?, ?, ?)`,
    [email, code, type, expiresAt],
    async function(err) {
      if (err) return res.json({ error: '发送失败' });
      
      const result = await sendEmail(
        email,
        '香蕉AI - 验证码',
        `<div style="max-width: 600px; margin: 0 auto; font-family: Arial, sans-serif; color: #333;">
          <h2 style="color: #f59e0b;">香蕉AI 验证码</h2>
          <p>您的验证码是：</p>
          <div style="font-size: 32px; font-weight: bold; color: #f59e0b; padding: 20px; background: #f5f5f5; text-align: center; border-radius: 8px; margin: 20px 0;">
            ${code}
          </div>
          <p>此验证码10分钟内有效，请勿泄露给他人。</p>
          <p style="color: #999; font-size: 12px;">如非本人操作，请忽略此邮件。</p>
        </div>`
      );
      
      if (result.success) {
        if (result.preview) {
          res.json({ success: true, preview: true, code: code, msg: '开发模式：验证码已打印到控制台' });
        } else {
          res.json({ success: true, msg: '验证码已发送到您的邮箱' });
        }
      } else {
        res.json({ error: '邮件发送失败，请稍后重试' });
      }
    });
});

// 注册
app.post('/api/auth/register', (req, res) => {
  const { email, password, code } = req.body;
  
  if (!email || !password || !code) {
    return res.json({ error: '请填写完整信息' });
  }
  
  db.get(`SELECT * FROM email_verifications 
          WHERE email = ? AND code = ? AND type = 'register' AND used = 0 AND expires_at > datetime('now')
          ORDER BY id DESC LIMIT 1`,
    [email, code],
    function(err, record) {
      if (err || !record) {
        return res.json({ error: '验证码错误或已过期' });
      }
      
      db.run('UPDATE email_verifications SET used = 1 WHERE id = ?', [record.id]);
      
      const hash = bcrypt.hashSync(password, 8);
      db.run('INSERT INTO users (email, password, email_verified) VALUES (?, ?, 1)', 
        [email, hash],
        function(err) {
          if (err) return res.json({ error: '注册失败，邮箱可能已被使用' });
          
          db.run(`INSERT INTO api_configs (user_id, provider_id, name, api_url, api_key, model, is_default) 
                  VALUES (?, 't8star', '贞贞的AI工坊', 'https://ai.t8star.cn/v1/images/generations', '', 'nano-banana-2', 1)`,
            [this.lastID]);
          
          res.json({ success: true, msg: '注册成功' });
        });
    });
});

// 登录
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (err || !user || !bcrypt.compareSync(password, user.password)) {
      return res.json({ error: '邮箱或密码错误' });
    }
    
    if (!user.email_verified && user.role !== 'admin') {
      return res.json({ error: '请先验证邮箱', needVerify: true });
    }
    
    req.session.userId = user.id;
    req.session.role = user.role;
    res.json({ success: true, role: user.role });
  });
});

// 获取用户信息
app.get('/api/user', requireAuth, (req, res) => {
  db.get('SELECT id, email, role, created_at FROM users WHERE id = ?', 
    [req.session.userId], (err, user) => {
      if (err || !user) return res.status(500).json({ error: '查询失败' });
      res.json(user);
    });
});

// 退出
app.get('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// API配置管理
app.get('/api/user/apis', requireAuth, (req, res) => {
  db.all('SELECT * FROM api_configs WHERE user_id = ? ORDER BY is_default DESC', 
    [req.session.userId], (err, rows) => {
      if (err) return res.status(500).json({ error: '查询失败' });
      res.json(rows);
    });
});

app.post('/api/user/apis', requireAuth, (req, res) => {
  const { provider_id, name, api_url, api_key, model, is_default } = req.body;
  
  if (!name || !api_url || !api_key) {
    return res.json({ error: '请填写完整信息' });
  }
  
  db.serialize(() => {
    if (is_default) {
      db.run('UPDATE api_configs SET is_default = 0 WHERE user_id = ?', [req.session.userId]);
    }
    
    db.run(`INSERT INTO api_configs (user_id, provider_id, name, api_url, api_key, model, is_default) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.session.userId, provider_id || 'custom', name, api_url, api_key, model || 'dall-e-3', is_default ? 1 : 0],
      function(err) {
        if (err) return res.status(500).json({ error: '保存失败' });
        res.json({ success: true, id: this.lastID });
      });
  });
});

app.put('/api/user/apis/:id', requireAuth, (req, res) => {
  const { name, api_url, api_key, model, is_default } = req.body;
  
  db.serialize(() => {
    if (is_default) {
      db.run('UPDATE api_configs SET is_default = 0 WHERE user_id = ?', [req.session.userId]);
    }
    
    db.run(`UPDATE api_configs SET name = ?, api_url = ?, api_key = ?, model = ?, is_default = ? 
            WHERE id = ? AND user_id = ?`,
      [name, api_url, api_key, model, is_default ? 1 : 0, req.params.id, req.session.userId],
      function(err) {
        if (err) return res.status(500).json({ error: '更新失败' });
        res.json({ success: true });
      });
  });
});

app.delete('/api/user/apis/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM api_configs WHERE id = ? AND user_id = ?', 
    [req.params.id, req.session.userId],
    function(err) {
      if (err) return res.status(500).json({ error: '删除失败' });
      res.json({ success: true });
    });
});

app.get('/api/user/apis/default', requireAuth, async (req, res) => {
  db.get('SELECT * FROM api_configs WHERE user_id = ? AND is_default = 1 LIMIT 1',
    [req.session.userId], (err, row) => {
      if (err) return res.status(500).json({ error: '查询失败' });
      if (!row) return res.status(404).json({ error: '未配置默认API' });
      res.json(row);
    });
});

// 文生图
app.post('/api/generate', requireAuth, async (req, res) => {
  const { prompt, size = '1024x1024' } = req.body;
  
  const config = await new Promise((resolve) => {
    db.get('SELECT * FROM api_configs WHERE user_id = ? AND is_default = 1 LIMIT 1',
      [req.session.userId], (err, row) => resolve(row));
  });
  
  if (!config) return res.json({ error: '请先配置默认API' });
  if (!config.api_key) return res.json({ error: 'API Key为空，请先配置' });
  
  try {
    const validSizes = ['512x512', '1024x1024', '1792x1024', '1024x1792', '2048x2048', '4096x4096', '3840x2160'];
    const finalSize = validSizes.includes(size) ? size : '1024x1024';
    
    const response = await axios.post(
      config.api_url,
      {
        model: config.model || 'dall-e-3',
        prompt: prompt,
        n: 1,
        size: finalSize
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
      [req.session.userId, prompt, imageUrl, finalSize, 'text2img', config.name, 'success']);
    
    res.json({ success: true, image_url: imageUrl, size: finalSize });
  } catch (error) {
    const errorMsg = error.response?.data?.error?.message || error.message;
    db.run('INSERT INTO generations (user_id, prompt, size, type, status, error_msg) VALUES (?, ?, ?, ?, ?, ?)',
      [req.session.userId, prompt, size, 'text2img', 'failed', errorMsg]);
    res.json({ error: '生成失败', detail: errorMsg });
  }
});

// 图生图
app.post('/api/img2img', requireAuth, upload.single('image'), async (req, res) => {
  const { prompt, size = '1024x1024' } = req.body;
  
  const config = await new Promise((resolve) => {
    db.get('SELECT * FROM api_configs WHERE user_id = ? AND is_default = 1 LIMIT 1',
      [req.session.userId], (err, row) => resolve(row));
  });
  
  if (!config || !config.api_key) {
    if (req.file) fs.unlinkSync(path.join(__dirname, req.file.path));
    return res.json({ error: '请先配置API' });
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
      [req.session.userId, prompt, imageUrl, size, 'img2img', config.name, 'success']);
    
    res.json({ success: true, image_url: imageUrl });
  } catch (error) {
    if (req.file) fs.unlinkSync(path.join(__dirname, req.file.path));
    const errorMsg = error.response?.data?.error?.message || error.message;
    res.json({ error: '生成失败', detail: errorMsg });
  }
});

// 多图参考
app.post('/api/multi-ref', requireAuth, upload.array('images', 4), async (req, res) => {
  const { prompt, size = '1024x1024' } = req.body;
  
  const config = await new Promise((resolve) => {
    db.get('SELECT * FROM api_configs WHERE user_id = ? AND is_default = 1 LIMIT 1',
      [req.session.userId], (err, row) => resolve(row));
  });
  
  if (!config || !config.api_key) {
    req.files?.forEach(file => fs.unlinkSync(path.join(__dirname, file.path)));
    return res.json({ error: '请先配置API' });
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
      [req.session.userId, prompt, imageUrl, size, 'multi-ref', config.name, 'success']);
    
    res.json({ success: true, image_url: imageUrl });
  } catch (error) {
    req.files?.forEach(file => {
      try { fs.unlinkSync(path.join(__dirname, file.path)); } catch(e) {}
    });
    const errorMsg = error.response?.data?.error?.message || error.message;
    res.json({ error: '生成失败', detail: errorMsg });
  }
});

// 获取历史记录
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

// 删除历史记录
app.delete('/api/history/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM generations WHERE id = ? AND user_id = ?', 
    [req.params.id, req.session.userId],
    function(err) {
      if (err) return res.status(500).json({ error: '删除失败' });
      res.json({ success: true });
    });
});

// 管理员接口
app.get('/api/admin/users', requireAdmin, (req, res) => {
  db.all(`SELECT u.id, u.email, u.role, u.email_verified, u.created_at, COUNT(g.id) as total_generations
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
          total_users: u.total_users,
          total_generations: g.total_gens,
          today_generations: t.today_gens
        });
      });
    });
  });
});

app.listen(PORT, () => {
  console.log(`🍌 香蕉 AI 服务器运行在端口 ${PORT}`);
  console.log(`数据库路径: ${DB_PATH}`);
  console.log(`管理员账号: ${process.env.ADMIN_EMAIL || 'admin@banana.ai'} / ${process.env.ADMIN_PASSWORD || 'admin123'}`);
  console.log(`环境: ${process.env.NODE_ENV || 'development'}`);
  if (!mailTransporter) {
    console.log(`⚠️ 警告: 未配置SMTP，邮件验证码功能将使用控制台模拟模式`);
    console.log(`   如需真实邮件功能，请设置环境变量 SMTP_HOST, SMTP_USER, SMTP_PASS`);
  }
});
