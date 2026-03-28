# OpenAPI Documentation

This document explains how to use and maintain the OpenAPI specification for the StellarSettle API.

## Overview

The StellarSettle API uses OpenAPI 3.0.3 specification to provide:
- Interactive API documentation at `/api/docs`
- Single source of truth for request/response shapes
- Reduced integration drift for frontend teams and partners
- Faster code reviews with clear API contracts

## Accessing Documentation

### Development
- URL: `http://localhost:3000/api/docs`
- Available when running `npm run dev`

### Production
- URL: `https://api.stellarsettle.com/api/docs`

## Specification File

The OpenAPI specification is maintained in `openapi.yaml` at the project root.

### Current Endpoints

#### Health Check
- `GET /health` - API health status

#### Authentication
- `POST /api/v1/auth/wallet-login` - Login with Stellar wallet
- `POST /api/v1/auth/refresh` - Refresh JWT token  
- `GET /api/v1/auth/me` - Get current user info

## Standard Response Envelope

All API responses follow this standard envelope structure:

```yaml
ApiResponse:
  type: object
  properties:
    success:
      type: boolean
      description: Whether the request was successful
    data:
      oneOf:
        - type: object
        - type: array
        - type: 'null'
      description: Response data payload
    error:
      $ref: '#/components/schemas/Error'
    meta:
      type: object
      description: Additional metadata (pagination, etc.)
```

### Error Response Format

```yaml
Error:
  type: object
  properties:
    message:
      type: string
      description: Human-readable error message
    code:
      type: string
      description: Machine-readable error code
    details:
      type: object
      description: Additional error details
```

## Security

The API uses Bearer JWT authentication:
- Header: `Authorization: Bearer <token>`
- Scheme: `BearerAuth`
- Format: JWT

## Adding New Endpoints

When adding new endpoints:

1. **Update the OpenAPI spec first** in `openapi.yaml`
2. **Add the endpoint implementation** in the appropriate route file
3. **Use the standard response envelope** for consistency
4. **Test the endpoint** and verify documentation updates

### Example: Adding a New Endpoint

```yaml
# In openapi.yaml
/api/v1/users:
  get:
    tags:
      - Users
    summary: List all users
    operationId: listUsers
    security:
      - BearerAuth: []
    responses:
      '200':
        description: Users retrieved successfully
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ApiResponse'
```

```typescript
// In routes/users.ts
router.get('/', (req: Request, res: Response) => {
  res.json({
    success: true,
    data: users, // Your actual data
    error: null,
    meta: {}
  });
});
```

## Validation

### Validate the OpenAPI Spec

Run the validation script to check for YAML syntax errors:

```bash
npm run validate-api
```

This script:
- Validates YAML syntax
- Checks the spec can be parsed
- Reports the number of paths found
- Exits with error code if invalid

### CI Integration

Add the validation to your CI pipeline:

```yaml
# .github/workflows/ci.yml
- name: Validate OpenAPI Spec
  run: npm run validate-api
```

## Best Practices

### Schema Design
- Use reusable components for common objects
- Follow the standard response envelope
- Include example responses for all endpoints
- Use proper HTTP status codes

### Documentation
- Provide clear descriptions for all endpoints
- Include examples for request/response bodies
- Document all required parameters
- Use meaningful operation IDs

### Security
- Always include security requirements where needed
- Document authentication flows
- Include proper error responses for auth failures

## Tools and Resources

### Recommended Tools
- **Swagger UI**: Interactive documentation (built-in)
- **Swagger Editor**: Online OpenAPI editor
- **Postman**: Import OpenAPI for testing
- **Insomnia**: API client with OpenAPI support

### Resources
- [OpenAPI 3.0.3 Specification](https://spec.openapis.org/oas/v3.0.3)
- [Swagger UI Documentation](https://swagger.io/tools/swagger-ui/)
- [OpenAPI Best Practices](https://github.com/OAI/OpenAPI-Specification/blob/main/versions/3.0.3.md#best-practices)

## Troubleshooting

### Common Issues

1. **YAML Syntax Errors**
   - Check indentation (use spaces, not tabs)
   - Validate with `npm run validate-api`

2. **Documentation Not Loading**
   - Ensure `openapi.yaml` exists in project root
   - Check server is running and accessible
   - Verify file permissions

3. **Schema Validation Errors**
   - Check all required fields are included
   - Verify data types match implementation
   - Test with actual API responses

### Getting Help

- Check the [OpenAPI Specification](https://spec.openapis.org/oas/v3.0.3)
- Review existing endpoints in `openapi.yaml`
- Test with the interactive docs at `/api/docs`
- Run `npm run validate-api` for syntax checking

## Version History

- **v0.1.0** - Initial implementation with health and auth endpoints
  - Added standard response envelope
  - Configured Swagger UI
  - Added validation script
  - Documented authentication scheme
