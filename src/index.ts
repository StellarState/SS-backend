import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import { apiV1Routes } from './routes/apiV1';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Load OpenAPI specification
const openApiSpec = YAML.load('./openapi.yaml');

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// API Documentation
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'StellarSettle API Documentation'
}));

// Routes
app.get('/health', (req: express.Request, res: express.Response) => {
  res.json({
    success: true,
    data: {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '0.1.0'
    },
    error: null,
    meta: {}
  });
});

app.use('/api/v1', apiV1Routes);

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    data: null,
    error: {
      message: 'Internal server error',
      code: 'INTERNAL_ERROR'
    },
    meta: {}
  });
});

// 404 handler
app.use('*', (req: express.Request, res: express.Response) => {
  res.status(404).json({
    success: false,
    data: null,
    error: {
      message: 'Route not found',
      code: 'NOT_FOUND'
    },
    meta: {}
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 StellarSettle API running on port ${PORT}`);
    console.log(`📚 API Documentation: http://localhost:${PORT}/api/docs`);
  });
}

export default app;
