import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { badRequest } from '../lib/errors.js';
import { audit } from '../repos/audit.js';

export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) =>
    fn(req, res, next).catch(next);

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest(`Please check ${first.path.join('.') || 'the form'}: ${first.message}`, r.error.flatten());
  }
  return r.data;
}

export const logAction = (req: Request, action: string, entityType?: string, entityId?: string | null, detail?: Record<string, unknown>) =>
  audit(req.user?.id ?? null, action, entityType, entityId, detail, req.ip);

export const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be a valid date');
export const uuid = z.string().uuid();
export const optionalText = (max = 500) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
