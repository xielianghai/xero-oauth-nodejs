require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { XeroClient } = require('xero-node');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const TOKEN_FILE = path.join(__dirname, 'xero_tokens.json');

// ============ 可配置的根路径 ============
// 修改这里即可更改所有路由的前缀，例如 '/demo'、'/app' 或 '' (根路径)
const BASE_PATH = process.env.BASE_PATH || '';
// =======================================

// 从 XERO_REDIRECT_URI 中提取回调路径
const CALLBACK_PATH = new URL(process.env.XERO_REDIRECT_URI).pathname;

// 辅助函数：生成完整路径
const url = (relativePath) => `${BASE_PATH}${relativePath}`;

// 配置
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(url('/'), express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Session 配置（生产环境应使用更安全的设置）
const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'xero-dashboard-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true
  }
};
app.use(session(sessionConfig));

// Xero 客户端配置
const xero = new XeroClient({
  clientId: process.env.XERO_CLIENT_ID,
  clientSecret: process.env.XERO_CLIENT_SECRET,
  redirectUris: [process.env.XERO_REDIRECT_URI],
  scopes: [
    'openid',
    'profile',
    'email',
    'offline_access',
    'accounting.transactions.read',
    'accounting.contacts.read',
    'accounting.settings.read',
    'accounting.reports.read'
  ]
});

// ============ Token 持久化 ============

function saveTokens(tokenSet) {
  try {
    const data = {
      ...tokenSet,
      saved_at: new Date().toISOString()
    };
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
    console.log('Tokens saved successfully');
    return data;
  } catch (e) {
    console.error('Error saving tokens:', e.message);
    return null;
  }
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const content = fs.readFileSync(TOKEN_FILE, 'utf8');
      if (!content || content.trim() === '' || content.trim() === '{}') {
        console.log('Token file is empty');
        return null;
      }
      return JSON.parse(content);
    }
  } catch (e) {
    console.error('Error loading tokens:', e.message);
  }
  return null;
}

function deleteTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      fs.writeFileSync(TOKEN_FILE, '{}');
      console.log('Tokens cleared');
    }
  } catch (e) {
    console.error('Error clearing tokens:', e.message);
  }
}

// ============ 状态检查 ============

async function getStatus() {
  const tokens = loadTokens();
  let connected = false;
  let tenantId = null;
  let tenantName = '';
  
  if (tokens?.access_token) {
    try {
      xero.setTokenSet(tokens);
      
      const tokenSet = xero.readTokenSet();
      if (tokenSet?.expired?.()) {
        console.log('Token expired, refreshing...');
        const newTokenSet = await xero.refreshToken();
        saveTokens(newTokenSet);
      }
      
      const tenants = await xero.updateTenants();
      if (tenants?.length > 0) {
        tenantId = tenants[0].tenantId;
        tenantName = tenants[0].tenantName;
        connected = true;
      }
    } catch (e) {
      console.error('Token validation error:', e.message);
      connected = false;
    }
  }
  
  return { connected, tenantId, tenantName, tokens };
}

// ============ 中间件 ============

// 添加通用变量到所有视图
app.use((req, res, next) => {
  res.locals.redirectUri = process.env.XERO_REDIRECT_URI;
  res.locals.basePath = BASE_PATH;
  res.locals.url = url; // 让模板也能使用 url 函数
  next();
});

// 认证检查中间件
const requireAuth = async (req, res, next) => {
  const status = await getStatus();
  if (!status.connected) {
    return res.redirect(url('/login'));
  }
  req.xeroStatus = status;
  next();
};

// 错误处理辅助函数
const renderError = async (res, error, active = 'home') => {
  const status = await getStatus();
  res.render('error', { 
    error: error.message || error,
    ...status,
    active
  });
};

// ============ 路由 ============

// 创建路由器
const router = express.Router();

// 首页
router.get('/', async (req, res) => {
  try {
    const status = await getStatus();
    res.render('index', { ...status, active: 'home' });
  } catch (e) {
    console.error('Index error:', e.message);
    res.render('index', { 
      connected: false,
      tenantId: null,
      tenantName: '',
      tokens: null,
      active: 'home'
    });
  }
});

// 登录
router.get('/login', async (req, res) => {
  try {
    const consentUrl = await xero.buildConsentUrl();
    res.redirect(consentUrl);
  } catch (e) {
    console.error('Login error:', e.message);
    await renderError(res, e, 'home');
  }
});

// 刷新 Token
router.get('/refresh', async (req, res) => {
  try {
    const tokens = loadTokens();
    if (!tokens?.refresh_token) {
      return res.redirect(url('/login'));
    }
    
    xero.setTokenSet(tokens);
    const newTokenSet = await xero.refreshToken();
    saveTokens(newTokenSet);
    
    res.redirect(url('/'));
  } catch (e) {
    console.error('Refresh error:', e.message);
    res.redirect(url('/login'));
  }
});

// Dashboard
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const status = req.xeroStatus;
    
    const orgResponse = await xero.accountingApi.getOrganisations(status.tenantId);
    const organisation = orgResponse.body.organisations?.[0] || {};
    
    const invResponse = await xero.accountingApi.getInvoices(
      status.tenantId,
      undefined,  // ifModifiedSince
      undefined,  // where
      'Date DESC', // order
      undefined,  // iDs
      undefined,  // invoiceNumbers
      undefined,  // contactIDs
      undefined,  // statuses
      undefined,  // page
      undefined,  // includeArchived
      undefined,  // createdByMyApp
      undefined,  // unitdp
      undefined,  // summaryOnly
      10          // pageSize
    );
    const invoices = invResponse.body.invoices || [];
    
    res.render('dashboard', {
      ...status,
      active: 'dashboard',
      organisation,
      invoices
    });
  } catch (e) {
    console.error('Dashboard error:', e.message);
    await renderError(res, e, 'dashboard');
  }
});

// 发票列表
router.get('/invoices', requireAuth, async (req, res) => {
  try {
    const status = req.xeroStatus;
    const statusFilter = req.query.status || '';
    const where = statusFilter ? `Status=="${statusFilter}"` : undefined;
    
    const response = await xero.accountingApi.getInvoices(
      status.tenantId,
      undefined,    // ifModifiedSince
      where,        // where
      'Date DESC',  // order
      undefined,    // iDs
      undefined,    // invoiceNumbers
      undefined,    // contactIDs
      undefined,    // statuses
      undefined,    // page
      undefined,    // includeArchived
      undefined,    // createdByMyApp
      undefined,    // unitdp
      undefined,    // summaryOnly
      50            // pageSize
    );
    
    res.render('invoices', {
      ...status,
      active: 'invoices',
      invoices: response.body.invoices || [],
      statusFilter
    });
  } catch (e) {
    console.error('Invoices error:', e.message);
    await renderError(res, e, 'invoices');
  }
});

// 联系人列表
router.get('/contacts', requireAuth, async (req, res) => {
  try {
    const status = req.xeroStatus;
    
    const response = await xero.accountingApi.getContacts(
      status.tenantId,
      undefined,  // ifModifiedSince
      undefined,  // where
      'Name',     // order
      undefined,  // iDs
      undefined,  // page
      undefined,  // includeArchived
      undefined,  // summaryOnly
      undefined   // searchTerm
    );
    
    res.render('contacts', {
      ...status,
      active: 'contacts',
      contacts: response.body.contacts || []
    });
  } catch (e) {
    console.error('Contacts error:', e.message);
    await renderError(res, e, 'contacts');
  }
});

// 账户列表
router.get('/accounts', requireAuth, async (req, res) => {
  try {
    const status = req.xeroStatus;
    const response = await xero.accountingApi.getAccounts(status.tenantId);
    
    res.render('accounts', {
      ...status,
      active: 'accounts',
      accounts: response.body.accounts || []
    });
  } catch (e) {
    console.error('Accounts error:', e.message);
    await renderError(res, e, 'accounts');
  }
});

// Token 信息页面
router.get('/tokens', async (req, res) => {
  try {
    const status = await getStatus();
    res.render('tokens', { ...status, active: 'tokens' });
  } catch (e) {
    console.error('Tokens page error:', e.message);
    res.render('tokens', {
      connected: false,
      tenantId: null,
      tenantName: '',
      tokens: null,
      active: 'tokens'
    });
  }
});

// 完整 Token JSON API
router.get('/tokens/full', (req, res) => {
  const tokens = loadTokens();
  res.json(tokens || { error: 'No tokens saved' });
});

// 设置页面
router.get('/settings', async (req, res) => {
  const baseSettings = {
    clientId: process.env.XERO_CLIENT_ID ? '✓ Set' : '✗ Not Set',
    clientSecret: process.env.XERO_CLIENT_SECRET ? '✓ Set' : '✗ Not Set',
    scopes: xero.config?.scopes || []
  };
  
  try {
    const status = await getStatus();
    res.render('settings', { ...status, active: 'settings', ...baseSettings });
  } catch (e) {
    console.error('Settings error:', e.message);
    res.render('settings', {
      connected: false,
      tenantId: null,
      tenantName: '',
      tokens: null,
      active: 'settings',
      ...baseSettings
    });
  }
});

// 断开连接
router.get('/disconnect', (req, res) => {
  deleteTokens();
  res.redirect(url('/'));
});

// 挂载路由器到基础路径
app.use(BASE_PATH || '/', router);

// OAuth 回调（必须在配置的完整路径上）
// 注意：这个路由需要单独处理，因为 Xero 回调 URL 是完整路径
app.get(CALLBACK_PATH, async (req, res) => {
  try {
    const tokenSet = await xero.apiCallback(req.url);
    saveTokens(tokenSet);
    await xero.updateTenants();
    res.redirect(url('/'));
  } catch (e) {
    console.error('Callback error:', e.message);
    await renderError(res, e, 'home');
  }
});

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).render('error', {
    error: 'Internal Server Error',
    connected: false,
    tenantId: null,
    tenantName: '',
    tokens: null,
    active: 'home'
  });
});

// 启动服务器
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log('Xero Dashboard - Node.js');
  console.log('='.repeat(50));
  console.log(`BASE_PATH: ${BASE_PATH || '/ (root)'}`);
  console.log(`CLIENT_ID: ${process.env.XERO_CLIENT_ID ? '✓ Set' : '✗ Not Set'}`);
  console.log(`CLIENT_SECRET: ${process.env.XERO_CLIENT_SECRET ? '✗ Set' : '✗ Not Set'}`);
  console.log(`REDIRECT_URI: ${process.env.XERO_REDIRECT_URI}`);
  console.log('='.repeat(50));
  console.log(`Server running at http://0.0.0.0:${PORT}${BASE_PATH || '/'}`);
});