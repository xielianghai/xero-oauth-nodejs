require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { XeroClient } = require('xero-node');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const TOKEN_FILE = path.join(__dirname, 'xero_tokens.json');

// 配置
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'xero-dashboard-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Xero 客户端配置
const xero = new XeroClient({
  clientId: process.env.XERO_CLIENT_ID,
  clientSecret: process.env.XERO_CLIENT_SECRET,
  redirectUris: [process.env.XERO_REDIRECT_URI || 'https://dev.atomapp.cyou/rest/oauth2-credential/callback'],
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

// Token 持久化
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
      // 检查文件是否为空或无效
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
      // 写入空对象而不是删除文件（避免 Docker volume 问题）
      fs.writeFileSync(TOKEN_FILE, '{}');
      console.log('Tokens cleared');
    }
  } catch (e) {
    console.error('Error clearing tokens:', e.message);
  }
}

// 获取连接状态
async function getStatus(req) {
  const tokens = loadTokens();
  let connected = false;
  let tenantId = null;
  let tenantName = '';
  
  if (tokens && tokens.access_token) {
    try {
      xero.setTokenSet(tokens);
      
      // 检查 token 是否过期，如果过期则刷新
      const tokenSet = xero.readTokenSet();
      if (tokenSet && typeof tokenSet.expired === 'function' && tokenSet.expired()) {
        console.log('Token expired, refreshing...');
        const newTokenSet = await xero.refreshToken();
        saveTokens(newTokenSet);
      }
      
      const tenants = await xero.updateTenants();
      if (tenants && tenants.length > 0) {
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

// 中间件：添加状态到所有视图
app.use(async (req, res, next) => {
  res.locals.redirectUri = process.env.XERO_REDIRECT_URI || 'https://dev.atomapp.cyou/rest/oauth2-credential/callback';
  next();
});

// ===== 路由 =====

// 首页
app.get('/', async (req, res) => {
  try {
    const status = await getStatus(req);
    res.render('index', { 
      ...status,
      active: 'home'
    });
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
app.get('/login', async (req, res) => {
  try {
    const consentUrl = await xero.buildConsentUrl();
    res.redirect(consentUrl);
  } catch (e) {
    console.error('Login error:', e.message);
    res.render('error', { 
      error: e.message,
      connected: false,
      tenantId: null,
      tenantName: '',
      tokens: null,
      active: 'home'
    });
  }
});

// OAuth 回调
app.get('/rest/oauth2-credential/callback', async (req, res) => {
  try {
    const tokenSet = await xero.apiCallback(req.url);
    saveTokens(tokenSet);
    
    // 获取租户信息
    await xero.updateTenants();
    
    res.redirect('/');
  } catch (e) {
    console.error('Callback error:', e.message);
    res.render('error', { 
      error: e.message,
      connected: false,
      tenantId: null,
      tenantName: '',
      tokens: null,
      active: 'home'
    });
  }
});

// 刷新 Token
app.get('/refresh', async (req, res) => {
  try {
    const tokens = loadTokens();
    if (!tokens || !tokens.refresh_token) {
      return res.redirect('/login');
    }
    
    xero.setTokenSet(tokens);
    const newTokenSet = await xero.refreshToken();
    saveTokens(newTokenSet);
    
    res.redirect('/');
  } catch (e) {
    console.error('Refresh error:', e.message);
    res.redirect('/login');
  }
});

// Dashboard
app.get('/dashboard', async (req, res) => {
  try {
    const status = await getStatus(req);
    if (!status.connected) {
      return res.redirect('/login');
    }
    
    // 获取组织信息
    const orgResponse = await xero.accountingApi.getOrganisations(status.tenantId);
    const organisation = orgResponse.body.organisations?.[0] || {};
    
    // 获取最近发票 - 修复参数顺序
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
    const status = await getStatus(req);
    res.render('error', { 
      error: e.message, 
      ...status,
      active: 'dashboard'
    });
  }
});

// 发票列表
app.get('/invoices', async (req, res) => {
  try {
    const status = await getStatus(req);
    if (!status.connected) {
      return res.redirect('/login');
    }
    
    const statusFilter = req.query.status || '';
    let where = undefined;
    if (statusFilter) {
      where = `Status=="${statusFilter}"`;
    }
    
    // 修复 API 调用参数
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
    const status = await getStatus(req);
    res.render('error', { 
      error: e.message, 
      ...status,
      active: 'invoices'
    });
  }
});

// 联系人列表
app.get('/contacts', async (req, res) => {
  try {
    const status = await getStatus(req);
    if (!status.connected) {
      return res.redirect('/login');
    }
    
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
    const status = await getStatus(req);
    res.render('error', { 
      error: e.message, 
      ...status,
      active: 'contacts'
    });
  }
});

// 账户列表
app.get('/accounts', async (req, res) => {
  try {
    const status = await getStatus(req);
    if (!status.connected) {
      return res.redirect('/login');
    }
    
    const response = await xero.accountingApi.getAccounts(status.tenantId);
    
    res.render('accounts', {
      ...status,
      active: 'accounts',
      accounts: response.body.accounts || []
    });
  } catch (e) {
    console.error('Accounts error:', e.message);
    const status = await getStatus(req);
    res.render('error', { 
      error: e.message, 
      ...status,
      active: 'accounts'
    });
  }
});

// Token 信息
app.get('/tokens', async (req, res) => {
  try {
    const status = await getStatus(req);
    res.render('tokens', {
      ...status,
      active: 'tokens'
    });
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

// 完整 Token JSON
app.get('/tokens/full', (req, res) => {
  const tokens = loadTokens();
  res.json(tokens || { error: 'No tokens saved' });
});

// 设置
app.get('/settings', async (req, res) => {
  try {
    const status = await getStatus(req);
    res.render('settings', {
      ...status,
      active: 'settings',
      clientId: process.env.XERO_CLIENT_ID ? '✓ Set' : '✗ Not Set',
      clientSecret: process.env.XERO_CLIENT_SECRET ? '✓ Set' : '✗ Not Set',
      scopes: xero.config.scopes || []
    });
  } catch (e) {
    console.error('Settings error:', e.message);
    res.render('settings', {
      connected: false,
      tenantId: null,
      tenantName: '',
      tokens: null,
      active: 'settings',
      clientId: process.env.XERO_CLIENT_ID ? '✓ Set' : '✗ Not Set',
      clientSecret: process.env.XERO_CLIENT_SECRET ? '✓ Set' : '✗ Not Set',
      scopes: []
    });
  }
});

// 断开连接
app.get('/disconnect', (req, res) => {
  deleteTokens();
  res.redirect('/');
});

// 启动服务器
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log('Xero Dashboard - Node.js');
  console.log('='.repeat(50));
  console.log(`CLIENT_ID: ${process.env.XERO_CLIENT_ID ? '✓ Set' : '✗ Not Set'}`);
  console.log(`CLIENT_SECRET: ${process.env.XERO_CLIENT_SECRET ? '✓ Set' : '✗ Not Set'}`);
  console.log(`REDIRECT_URI: ${process.env.XERO_REDIRECT_URI || 'https://dev.atomapp.cyou/rest/oauth2-credential/callback'}`);
  console.log('='.repeat(50));
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});