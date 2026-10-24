// HTTP surface: the execute route the app's Pay button calls, and the x402
// receipt route only this service's own payer can reach.

import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";

import { ApiError } from "./apiClient.js";
import { RECEIPT_ROUTE } from "./cdp.js";
import { PaymentError, type Orchestrator } from "./orchestrator.js";
import type { BookingApi } from "./types.js";

export type AppDeps = {
  orchestrator: Orchestrator;
  api: BookingApi;
  serviceToken: string;
  /** Owner wallet address shown on the receipt. */
  payeeAddress: () => string;
  /** x402 payment gate for the receipt; omitted in tests that don't settle. */
  paywall?: RequestHandler;
};

const bearer = (req: Request) => /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "")?.[1];

export function createApp({ orchestrator, api, serviceToken, payeeAddress, paywall }: AppDeps) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/v1/payments/:bookingId/execute", async (req, res, next) => {
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ detail: "authentication required" });
      return;
    }
    try {
      const result = await orchestrator.executePayment(String(req.params.bookingId), token);
      res.status(result.booking.state === "RECONCILIATION_REQUIRED" ? 202 : 200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Only a PROCESSING booking can be paid for, and only by this service.
  const receiptGuard: RequestHandler = async (req, res, next) => {
    if (bearer(req) !== serviceToken) {
      res.status(403).json({ detail: "payment service only" });
      return;
    }
    try {
      const booking = await api.getBooking(String(req.params.bookingId));
      if (booking.state !== "PROCESSING") {
        res.status(409).json({ detail: `booking is ${booking.state}` });
        return;
      }
      res.locals.booking = booking;
      next();
    } catch (err) {
      next(err);
    }
  };

  app.get(RECEIPT_ROUTE, receiptGuard, ...(paywall ? [paywall] : []), (_req, res) => {
    const { booking } = res.locals;
    res.json({
      booking_id: booking.id,
      driveway_id: booking.driveway_id,
      amount_usdc: booking.amount_usdc,
      network: booking.network,
      payee_address: payeeAddress(),
    });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof PaymentError) {
      res.status(err.status).json({ detail: err.code, code: err.code, retryable: err.retryable, booking: err.booking });
      return;
    }
    if (err instanceof ApiError) {
      res.status(err.status).json({ detail: err.detail });
      return;
    }
    console.error("[payments] unexpected error", err);
    res.status(500).json({ detail: "internal error" });
  });

  return app;
}
