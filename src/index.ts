import { createApp } from "./app";
import { getConfig } from "./config/env";
import dataSource from "./config/database";
import { createAuthService } from "./services/auth.service";

export async function bootstrap(): Promise<void> {
  const config = getConfig();

  if (!dataSource.isInitialized) {
    await dataSource.initialize();
  }

  const authService = createAuthService(dataSource, config);
  const app = createApp({ authService });

  app.listen(config.port, () => {
    process.stdout.write(`StellarSettle API listening on port ${config.port}\n`);
  });
}

if (require.main === module) {
  void bootstrap();
}
