import { Router } from 'express';
import { authRoutes } from './auth';

const router = Router();

// Mount auth routes
router.use('/auth', authRoutes);

export const apiV1Routes = router;
