import { globals } from '../configs/globals.js';
import { log } from './log-util.js';
import crypto from 'crypto';

/**
 * 生成随机密码
 */
export function generateRandomPassword(length = 16) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  const randomBytes = crypto.randomBytes(length);

  for (let i = 0; i < length; i++) {
    password += charset[randomBytes[i] % charset.length];
  }

  return password;
}

/**
 * 哈希密码
 */
export function hashPassword(password) {
  return crypto.createHash('sha256').update(password + globals.passwordSalt).digest('hex');
}

/**
 * 验证密码
 */
export function verifyPassword(inputPassword, hashedPassword) {
  return hashPassword(inputPassword) === hashedPassword;
}

/**
 * 生成 JWT Token
 */
export function generateToken(username) {
  const payload = {
    username,
    exp: Date.now() + 24 * 60 * 60 * 1000 // 24小时过期
  };

  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', globals.jwtSecret)
    .update(`${header}.${body}`)
    .digest('base64url');

  return `${header}.${body}.${signature}`;
}

/**
 * 验证 JWT Token
 */
export function verifyToken(token) {
  try {
    const [header, body, signature] = token.split('.');

    const expectedSignature = crypto
      .createHmac('sha256', globals.jwtSecret)
      .update(`${header}.${body}`)
      .digest('base64url');

    if (signature !== expectedSignature) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());

    if (payload.exp < Date.now()) {
      return null;
    }

    return payload;
  } catch (error) {
    log('error', `[auth] Token 验证失败: ${error.message}`);
    return null;
  }
}

/**
 * 生成 Session ID
 */
export function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 初始化管理员用户
 */
export async function initAdminUser() {
  const databaseUrl = process.env.DATABASE_URL;
  
  if (!databaseUrl) {
    console.log('[auth] DATABASE_URL 未配置，跳过管理员用户初始化');
    return;
  }

  try {
    // 动态导入 @libsql/client
    const { createClient } = await import('@libsql/client');

    const db = createClient({
      url: databaseUrl,
      authToken: process.env.DATABASE_AUTH_TOKEN
    });

    // 创建用户表
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 检查是否已存在管理员用户
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: ['admin']
    });

    if (result.rows.length > 0) {
      console.log('[auth] 管理员用户已存在，跳过初始化');
      return;
    }

    // 生成随机密码（16位）
    const password = generateRandomPassword(16);
    const hashedPassword = hashPassword(password);

    // 创建管理员用户
    await db.execute({
      sql: 'INSERT INTO users (username, password) VALUES (?, ?)',
      args: ['admin', hashedPassword]
    });

    console.log('='.repeat(60));
    console.log('🎉 管理员用户创建成功！');
    console.log('用户名: admin');
    console.log(`密码: ${password}`);
    console.log('⚠️  请立即登录并修改密码！');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('[auth] 初始化管理员用户失败:', error.message);
    console.error('[auth] 错误详情:', error);
  }
}
