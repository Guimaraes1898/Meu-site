import { scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcrypt';

const scrypt = promisify(scryptCallback);
const bcryptRounds = 12;
const bcryptMaximumPasswordBytes = 72;
const bcryptHashPattern = /^\$2[aby]\$(0[4-9]|1[0-5])\$[./A-Za-z0-9]{53}$/;

export async function hashPassword(password) {
  if (Buffer.byteLength(password, 'utf8') > bcryptMaximumPasswordBytes) {
    throw new RangeError('Bcrypt passwords cannot exceed 72 UTF-8 bytes.');
  }
  return bcrypt.hash(password, bcryptRounds);
}

async function verifyScryptPassword(password, encodedHash) {
  const [, salt, storedHash] = encodedHash.split(':');
  if (
    !/^[a-f\d]{32}$/i.test(salt ?? '') ||
    !/^[a-f\d]{128}$/i.test(storedHash ?? '')
  ) {
    return false;
  }

  const actualHash = await scrypt(password, salt, 64);
  const expectedHash = Buffer.from(storedHash, 'hex');
  return timingSafeEqual(actualHash, expectedHash);
}

export async function verifyPassword(password, encodedHash) {
  if (typeof password !== 'string' || typeof encodedHash !== 'string') {
    return false;
  }

  if (bcryptHashPattern.test(encodedHash)) {
    if (Buffer.byteLength(password, 'utf8') > bcryptMaximumPasswordBytes) {
      return false;
    }
    return bcrypt.compare(password, encodedHash);
  }

  if (!encodedHash.startsWith('scrypt:')) {
    return false;
  }

  return verifyScryptPassword(password, encodedHash);
}
