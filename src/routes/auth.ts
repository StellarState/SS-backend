import { Router, Request, Response } from 'express';

const router = Router();

// POST /api/v1/auth/wallet-login
router.post('/wallet-login', (req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      user: {
        id: 'user_123',
        walletAddress: req.body.walletAddress || 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        role: 'seller',
        kycStatus: 'pending'
      },
      token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
      refreshToken: 'refresh_token_here'
    },
    error: null,
    meta: {}
  });
});

// POST /api/v1/auth/refresh
router.post('/refresh', (req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      token: 'new_jwt_token_here',
      refreshToken: 'new_refresh_token_here'
    },
    error: null,
    meta: {}
  });
});

// GET /api/v1/auth/me
router.get('/me', (req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      id: 'user_123',
      walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      role: 'seller',
      kycStatus: 'pending',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z'
    },
    error: null,
    meta: {}
  });
});

export { authRoutes as auth };
