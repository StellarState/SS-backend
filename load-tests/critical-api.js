import http from "k6/http";
import { check, sleep } from "k6";

const baseUrl = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const token = __ENV.AUTH_TOKEN || "";
const wallet = __ENV.REFERRAL_WALLET || "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export const options = {
  scenarios: {
    critical_api: {
      executor: "ramping-vus",
      startVUs: Number(__ENV.VUS || 1),
      stages: [
        { duration: __ENV.WARMUP || "30s", target: Number(__ENV.TARGET_VUS || 5) },
        { duration: __ENV.DURATION || "2m", target: Number(__ENV.TARGET_VUS || 5) },
        { duration: "15s", target: 0 },
      ],
    },
  },
  thresholds: { http_req_failed: ["rate<0.01"], http_req_duration: ["p(95)<750"] },
};

function get(path, name) {
  const response = http.get(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    tags: { flow: name },
  });
  check(response, { [`${name} responds`]: (r) => r.status < 500 });
}

export default function () {
  get("/health", "health");
  get("/api/v1/invoices?limit=20", "invoice-list");
  get(`/api/v1/referrals/${wallet}/tier`, "referral-tier");
  get("/api/v1/invoices/publish/validate", "publish-preflight");
  sleep(1);
}
