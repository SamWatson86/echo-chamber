import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

export type AuthTokenPayload = {
  sub: string;
  iat: number;
  exp: number;
  role?: "room" | "admin";
};

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signToken(secret: string, ttlHours: number, role: "room" | "admin" = "room"): string {
  return jwt.sign({ sub: role, role }, secret, { expiresIn: `${ttlHours}h` });
}

export function verifyToken(token: string, secret: string): AuthTokenPayload {
  return jwt.verify(token, secret) as AuthTokenPayload;
}

export function isAdminPayload(payload: AuthTokenPayload): boolean {
  return payload.role === "admin" || payload.sub === "admin";
}
