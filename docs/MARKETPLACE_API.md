# Marketplace API Documentation

The Marketplace API provides a read-only interface for investors to discover published receivables (invoices) available for investment. This decentralized marketplace allows investors to browse investment opportunities without exposing unnecessary seller PII.

## Overview

The marketplace endpoint allows unauthenticated access to published invoices, providing essential investment signals like discount rates, amounts, and due dates while protecting sensitive seller information.

## API Endpoint

### List Published Invoices

**GET** `/api/v1/marketplace/invoices`

Returns a paginated list of invoices available for investment.

#### Authentication
- **No authentication required** - Public read access for published invoices only
- This reduces friction for investors to discover opportunities

#### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | 1 | Page number (min: 1) |
| `limit` | integer | 20 | Items per page (min: 1, max: 100) |
| `status` | string/array | `["published"]` | Invoice status filter |
| `dueBefore` | ISO date | - | Filter invoices due before this date |
| `minAmount` | number | - | Minimum invoice amount |
| `maxAmount` | number | - | Maximum invoice amount |
| `sort` | string | `"due_date"` | Sort field: `due_date`, `discount_rate`, `amount`, `created_at` |
| `sortOrder` | string | `"ASC"` | Sort order: `ASC` or `DESC` |

#### Response Format

**Success (200)**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "invoiceNumber": "INV-001",
      "customerName": "Customer Corp",
      "amount": "10000.00",
      "discountRate": "5.50",
      "netAmount": "9450.00",
      "dueDate": "2024-12-31T00:00:00.000Z",
      "status": "published",
      "createdAt": "2024-01-15T10:30:00.000Z"
    }
  ],
  "meta": {
    "total": 150,
    "page": 1,
    "limit": 20,
    "totalPages": 8
  }
}
```

**Error Responses**
- `400` - Invalid query parameters
- `500` - Server error

## Public Fields

The API exposes only investor-relevant fields while protecting seller privacy:

### ✅ **Public Fields (Exposed)**
- `id` - Invoice identifier for investment references
- `invoiceNumber` - Public invoice reference
- `customerName` - Debtor information (relevant for credit assessment)
- `amount` - Full invoice value
- `discountRate` - Discount percentage offered
- `netAmount` - Amount after discount (what seller receives)
- `dueDate` - Payment due date (tenor information)
- `status` - Current invoice status
- `createdAt` - When invoice was created

### ❌ **Private Fields (Hidden)**
- `sellerId` - Seller identity protection
- `ipfsHash` - Internal document references
- `riskScore` - Internal risk assessments
- `smartContractId` - Technical implementation details
- `updatedAt` - Internal timestamps
- `deletedAt` - Soft deletion markers

## Privacy Rationale

The field selection balances investor needs with seller privacy:

1. **Investment Signals**: Discount rate, amount, and due date provide essential yield and risk information
2. **Credit Assessment**: Customer name allows investors to evaluate debtor creditworthiness
3. **Privacy Protection**: Seller identity and internal risk scores remain confidential
4. **Operational Security**: Technical details like IPFS hashes and contract IDs are hidden

## Usage Examples

### Basic Listing
```bash
curl "https://api.stellarsettle.com/api/v1/marketplace/invoices"
```

### Filtered Search
```bash
curl "https://api.stellarsettle.com/api/v1/marketplace/invoices?minAmount=1000&maxAmount=50000&sort=discount_rate&sortOrder=DESC"
```

### Date-Based Filtering
```bash
curl "https://api.stellarsettle.com/api/v1/marketplace/invoices?dueBefore=2024-12-31T23:59:59.999Z&sort=due_date"
```

### Pagination
```bash
curl "https://api.stellarsettle.com/api/v1/marketplace/invoices?page=2&limit=50"
```

### Multiple Status Filter
```bash
curl "https://api.stellarsettle.com/api/v1/marketplace/invoices?status=published&status=funded"
```

## Filtering & Sorting

### Status Filtering
- **Default**: Only `published` invoices (ready for investment)
- **Available statuses**: `published`, `funded`, `settled` (though `funded` and `settled` are less relevant for new investments)
- **Multiple values**: Use array format or repeat parameter

### Amount Filtering
- Both `minAmount` and `maxAmount` are optional
- Validation ensures `minAmount ≤ maxAmount`
- Useful for portfolio size constraints

### Date Filtering
- `dueBefore`: Find invoices with shorter tenors
- ISO 8601 date format required
- Timezone-aware filtering

### Sorting Options
- **`due_date`**: Sort by payment due date (tenor)
- **`discount_rate`**: Sort by yield/discount offered
- **`amount`**: Sort by invoice size
- **`created_at`**: Sort by listing recency

## Pagination

- **Stable ordering**: Results use `ORDER BY {sort_field} {order}, id ASC` for consistent pagination
- **Reasonable limits**: Maximum 100 items per page to prevent abuse
- **Complete metadata**: Response includes total count and page calculations

## Performance Considerations

- **Database indexes**: Optimized queries on `status`, `due_date`, `amount`, and `created_at`
- **Soft deletes**: Automatically excludes deleted invoices
- **Efficient counting**: Separate count query for accurate totals

## Integration Notes

### Frontend Integration
```javascript
// Fetch marketplace data
const response = await fetch('/api/v1/marketplace/invoices?page=1&limit=20&sort=discount_rate&sortOrder=DESC');
const { data, meta } = await response.json();

// Display investment opportunities
data.forEach(invoice => {
  console.log(`${invoice.invoiceNumber}: ${invoice.discountRate}% discount, due ${invoice.dueDate}`);
});
```

### Investment Flow
1. **Discovery**: Browse marketplace for suitable invoices
2. **Analysis**: Evaluate discount rate, amount, tenor, and debtor
3. **Investment**: Use separate investment API (out of scope for this endpoint)

## Security & Privacy

- **No authentication required**: Reduces friction for discovery
- **Public data only**: No sensitive seller information exposed
- **Rate limiting**: Standard API rate limits apply
- **CORS enabled**: Supports browser-based applications

## Future Enhancements

Potential future features (out of current scope):
- Full-text search across invoice documents
- Advanced filtering (industry, geography, credit ratings)
- Real-time updates via WebSocket
- Bulk export capabilities