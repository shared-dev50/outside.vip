import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import { env } from './config/env.js';
import { authenticateUser } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { healthRouter } from './modules/health/health.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { eventsRouter } from './modules/events/events.routes.js';
import { organizerRouter } from './modules/organizer/organizer.routes.js';
import { checkoutRouter } from './modules/checkout/checkout.routes.js';
import { webhookRouter } from './modules/webhooks/webhook.routes.js';
import { ordersRouter } from './modules/orders/orders.routes.js';

export const app = express();

// Security and utility middleware
app.use(
  cors({
    origin: [env.CLIENT_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
  })
);

if (env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// Preserve raw body for webhook verification if needed
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Global auth context attachment
app.use(authenticateUser);

// API Route Handlers
app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/events', eventsRouter);
app.use('/api/organizer', organizerRouter);
app.use('/api/checkout', checkoutRouter);
app.use('/api/webhooks', webhookRouter);
app.use('/api/orders', ordersRouter);

// Fallback 404 handler
app.use('/api/*', (_req, res) => {
  res.status(404).json({
    success: false,
    error: {
      message: 'API route not found',
      statusCode: 404,
    },
  });
});

// Centralized error handler
app.use(errorHandler);
