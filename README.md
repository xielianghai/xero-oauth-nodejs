# Xero Dashboard (Node.js)

使用 Node.js + Express + xero-node SDK 构建的 Xero OAuth2 Dashboard。

## 功能

- 🔐 OAuth2 认证
- 📊 Dashboard - 组织信息 + 最近发票
- 📄 Invoices - 发票列表（支持状态筛选）
- 👥 Contacts - 联系人列表
- 🏦 Accounts - 会计科目表
- 🔑 Tokens - 查看/刷新 Token
- ⚙️ Settings - 配置管理

## 部署步骤

### 1. 配置 Xero 应用

1. 访问 https://developer.xero.com/app/manage
2. 创建新应用，设置 Redirect URI: `https://dev.atomapp.cyou/callback`
3. 记录 Client ID 和 Client Secret

### 2. 配置环境变量

```bash
cp .env.example .env
nano .env
```

填入:
```
XERO_CLIENT_ID=your_client_id
XERO_CLIENT_SECRET=your_client_secret
XERO_REDIRECT_URI=https://dev.atomapp.cyou/callback
SESSION_SECRET=随机字符串
```

### 3. Docker 部署（推荐）

```bash
# 创建空的 token 文件
touch xero_tokens.json

# 启动
docker-compose up -d --build

# 查看日志
docker logs -f xero-app
```

### 4. 直接运行

```bash
npm install
npm start
```

## API 端点

| 路径 | 说明 |
|------|------|
| `/` | 首页 |
| `/login` | 开始 OAuth 认证 |
| `/callback` | OAuth 回调 |
| `/dashboard` | Dashboard |
| `/invoices` | 发票列表 |
| `/contacts` | 联系人 |
| `/accounts` | 账户 |
| `/tokens` | Token 信息 |
| `/tokens/full` | 完整 Token JSON |
| `/settings` | 设置 |
| `/refresh` | 刷新 Token |
| `/disconnect` | 断开连接 |

## 目录结构

```
xero-app/
├── server.js          # 主服务器
├── views/             # EJS 模板
│   ├── layout.ejs
│   ├── index.ejs
│   ├── dashboard.ejs
│   ├── invoices.ejs
│   ├── contacts.ejs
│   ├── accounts.ejs
│   ├── tokens.ejs
│   ├── settings.ejs
│   └── error.ejs
├── public/
│   └── style.css      # 样式
├── package.json
├── Dockerfile
├── docker-compose.yml
└── .env
```
# xero-oauth-nodejs
