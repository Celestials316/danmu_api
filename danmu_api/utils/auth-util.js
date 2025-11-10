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
