import { Request, Response, NextFunction } from "express";
import { nanoid } from "nanoid";
import { ApiResponse } from "@spell/shared-types";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export function requestIdMiddleware(req: Request, _res: Response, next: NextFunction) {
  req.requestId = `req_${nanoid(12)}`;
  next();
}

export function sendOk<T>(res: Response, data: T, status = 200) {
  const body: ApiResponse<T> = {
    ok: true,
    data,
    error: null,
    requestId: res.req.requestId,
  };
  res.status(status).json(body);
}

export function sendErr(
  res: Response,
  status: number,
  code: string,
  message: string
) {
  const body: ApiResponse<null> = {
    ok: false,
    data: null,
    error: { code, message },
    requestId: res.req.requestId,
  };
  res.status(status).json(body);
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function asyncRoute(
  fn: (req: Request, res: Response) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((e) => {
      if (e instanceof ApiError) {
        sendErr(res, e.status, e.code, e.message);
      } else {
        // eslint-disable-next-line no-console
        console.error(e);
        sendErr(res, 500, "internal_error", "Errore interno");
      }
    });
  };
}
