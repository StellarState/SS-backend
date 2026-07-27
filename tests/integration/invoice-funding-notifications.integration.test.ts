import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { DataSource } from "typeorm";
import { Notification } from "../../src/models/Notification.model";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { User } from "../../src/models/User.model";
import { createNotificationService } from "../../src/services/notification.service";
import { InvestmentService } from "../../src/services/investment.service";
import { InvoiceStatus, KYCStatus, NotificationType, UserType } from "../../src/types/enums";

describe("Invoice funding notifications integration", () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      console.warn("DATABASE_URL not set, skipping integration tests");
      return;
    }

    dataSource = new DataSource({
      type: "postgres",
      url: databaseUrl,
      entities: [User, Invoice, Investment, Notification],
      synchronize: true,
      logging: false,
      dropSchema: true,
    });

    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource && dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("creates notifications for each committed investor and the seller when an invoice is funded", async () => {
    if (!dataSource || !dataSource.isInitialized) {
      console.warn("Skipping test - DATABASE_URL not configured");
      return;
    }

    const userRepository = dataSource.getRepository(User);
    const invoiceRepository = dataSource.getRepository(Invoice);
    const notificationRepository = dataSource.getRepository(Notification);

    const seller = await userRepository.save(
      userRepository.create({
        stellarAddress: "GSELLERNOTIFY1234567890ABCDEFGHIJKLMNOPQRST",
        email: "seller-notify@test.com",
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      }),
    );

    const investorA = await userRepository.save(
      userRepository.create({
        stellarAddress: "GINVESTORNOTIFYA1234567890ABCDEFGHIJKLMNOPQ",
        email: "investor-a@test.com",
        userType: UserType.INVESTOR,
        kycStatus: KYCStatus.APPROVED,
      }),
    );

    const investorB = await userRepository.save(
      userRepository.create({
        stellarAddress: "GINVESTORNOTIFYB1234567890ABCDEFGHIJKLMNOPQ",
        email: "investor-b@test.com",
        userType: UserType.INVESTOR,
        kycStatus: KYCStatus.APPROVED,
      }),
    );

    const invoice = await invoiceRepository.save(
      invoiceRepository.create({
        sellerId: seller.id,
        invoiceNumber: "INV-NOTIFY-001",
        customerName: "Notify Customer",
        amount: "1000.0000",
        discountRate: "10.00",
        netAmount: "900.0000",
        dueDate: new Date("2025-12-31"),
        status: InvoiceStatus.PUBLISHED,
      }),
    );

    const notificationService = createNotificationService(dataSource);
    const investmentService = new InvestmentService(dataSource, notificationService);

    await investmentService.createInvestment({
      invoiceId: invoice.id,
      investorId: investorA.id,
      investmentAmount: "450.0000",
      investorWallet: investorA.stellarAddress,
    });

    await investmentService.createInvestment({
      invoiceId: invoice.id,
      investorId: investorB.id,
      investmentAmount: "450.0000",
      investorWallet: investorB.stellarAddress,
    });

    const fundedInvoice = await invoiceRepository.findOne({ where: { id: invoice.id } });
    expect(fundedInvoice?.status).toBe(InvoiceStatus.FUNDED);

    const investorANotifications = await notificationRepository.find({ where: { userId: investorA.id } });
    const investorBNotifications = await notificationRepository.find({ where: { userId: investorB.id } });
    const sellerNotifications = await notificationRepository.find({ where: { userId: seller.id } });

    expect(investorANotifications).toHaveLength(1);
    expect(investorBNotifications).toHaveLength(1);
    expect(sellerNotifications).toHaveLength(1);

    for (const notification of [...investorANotifications, ...investorBNotifications, ...sellerNotifications]) {
      expect(notification.type).toBe(NotificationType.INVOICE);
      expect(notification.title).toBe("Invoice fully funded");
      expect(notification.message).toContain(invoice.invoiceNumber);
      expect(notification.message).toContain("900.0000");
    }

    const notificationCountBeforeReplay = await notificationRepository.count();

    await investmentService.notifyInvoiceFullyFunded(invoice.id);

    const reloadedInvestorANotifications = await notificationRepository.find({ where: { userId: investorA.id } });
    const reloadedInvestorBNotifications = await notificationRepository.find({ where: { userId: investorB.id } });
    const reloadedSellerNotifications = await notificationRepository.find({ where: { userId: seller.id } });
    const notificationCountAfterReplay = await notificationRepository.count();

    expect(reloadedInvestorANotifications).toHaveLength(1);
    expect(reloadedInvestorBNotifications).toHaveLength(1);
    expect(reloadedSellerNotifications).toHaveLength(1);
    expect(notificationCountAfterReplay).toBe(notificationCountBeforeReplay);
  });
});