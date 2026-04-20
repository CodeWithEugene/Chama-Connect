/**
 * Daraja (Safaricom M-Pesa) sandbox client.
 *
 * Covers the four endpoints that matter for a chama:
 *   - STK Push              (C2B initiated by our app, customer types PIN)
 *   - C2B Register URLs     (tell Safaricom where to POST validations/confirmations)
 *   - B2C Payment Request   (disburse loans from chama paybill to member phone)
 *   - Transaction Status    (poll when a callback is missed)
 *
 * Access token is cached in-memory with a safety buffer.
 */

import axios, { AxiosInstance } from "axios";

export type DarajaConfig = {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  initiatorName: string;
  initiatorPassword: string; // sandbox only — prod uses cert-encrypted value
  callbackBase: string;
};

type TokenCache = { token: string; expiresAt: number };

export class DarajaClient {
  private http: AxiosInstance;
  private token: TokenCache | null = null;

  constructor(private cfg: DarajaConfig) {
    this.http = axios.create({ baseURL: cfg.baseUrl, timeout: 20_000 });
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): DarajaClient {
    const required = [
      "DARAJA_BASE_URL",
      "DARAJA_CONSUMER_KEY",
      "DARAJA_CONSUMER_SECRET",
      "DARAJA_BUSINESS_SHORTCODE",
      "DARAJA_PASSKEY",
      "DARAJA_INITIATOR_NAME",
      "DARAJA_INITIATOR_PASSWORD",
    ] as const;
    for (const k of required) {
      if (!env[k]) throw new Error(`missing env ${k}`);
    }
    return new DarajaClient({
      baseUrl: env.DARAJA_BASE_URL!,
      consumerKey: env.DARAJA_CONSUMER_KEY!,
      consumerSecret: env.DARAJA_CONSUMER_SECRET!,
      shortcode: env.DARAJA_BUSINESS_SHORTCODE!,
      passkey: env.DARAJA_PASSKEY!,
      initiatorName: env.DARAJA_INITIATOR_NAME!,
      initiatorPassword: env.DARAJA_INITIATOR_PASSWORD!,
      callbackBase: env.DARAJA_CALLBACK_BASE ?? env.PUBLIC_BASE_URL ?? "",
    });
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt - 60_000 > now) return this.token.token;
    const creds = Buffer.from(
      `${this.cfg.consumerKey}:${this.cfg.consumerSecret}`
    ).toString("base64");
    const { data } = await this.http.get("/oauth/v1/generate", {
      params: { grant_type: "client_credentials" },
      headers: { Authorization: `Basic ${creds}` },
    });
    const expiresIn = Number(data.expires_in ?? 3599) * 1000;
    this.token = { token: data.access_token, expiresAt: now + expiresIn };
    return this.token.token;
  }

  private async authed(): Promise<{ Authorization: string; "Content-Type": string }> {
    const t = await this.getAccessToken();
    return { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
  }

  /**
   * Generate the timestamp + password required by STK Push.
   * Password = base64(Shortcode + Passkey + Timestamp), timestamp YYYYMMDDHHmmss.
   */
  private stkPassword(): { timestamp: string; password: string } {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const timestamp =
      d.getFullYear().toString() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds());
    const password = Buffer.from(
      this.cfg.shortcode + this.cfg.passkey + timestamp
    ).toString("base64");
    return { timestamp, password };
  }

  /**
   * STK Push: send the customer an M-Pesa prompt on their handset.
   * msisdn must be in 2547XXXXXXXX format (no +).
   */
  async stkPush(params: {
    msisdn: string;
    amount: number; // whole KES (Safaricom rounds to integer)
    accountReference: string;
    transactionDesc?: string;
  }): Promise<StkPushResponse> {
    const { timestamp, password } = this.stkPassword();
    const body = {
      BusinessShortCode: this.cfg.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: params.amount,
      PartyA: params.msisdn,
      PartyB: this.cfg.shortcode,
      PhoneNumber: params.msisdn,
      CallBackURL: `${this.cfg.callbackBase}/api/mpesa/stk/callback`,
      AccountReference: params.accountReference.slice(0, 12),
      TransactionDesc: (params.transactionDesc ?? "Chama contribution").slice(0, 13),
    };
    const headers = await this.authed();
    const { data } = await this.http.post(
      "/mpesa/stkpush/v1/processrequest",
      body,
      { headers }
    );
    return data as StkPushResponse;
  }

  /**
   * Tell Safaricom where to POST confirmations + validations for our paybill.
   * Idempotent — call once at startup or on paybill change.
   */
  async registerC2BUrls(): Promise<C2BRegisterResponse> {
    const body = {
      ShortCode: this.cfg.shortcode,
      ResponseType: "Completed",
      ConfirmationURL: `${this.cfg.callbackBase}/api/mpesa/c2b/confirmation`,
      ValidationURL: `${this.cfg.callbackBase}/api/mpesa/c2b/validation`,
    };
    const headers = await this.authed();
    const { data } = await this.http.post(
      "/mpesa/c2b/v1/registerurl",
      body,
      { headers }
    );
    return data as C2BRegisterResponse;
  }

  /**
   * B2C: pay a member (e.g. loan disbursement).
   * Sandbox accepts plain initiator password; production requires RSA-encrypted SecurityCredential.
   */
  async b2cPayment(params: {
    msisdn: string;
    amount: number;
    commandId?: "SalaryPayment" | "BusinessPayment" | "PromotionPayment";
    remarks?: string;
    occasion?: string;
  }): Promise<B2CResponse> {
    const body = {
      InitiatorName: this.cfg.initiatorName,
      SecurityCredential: this.cfg.initiatorPassword, // sandbox only
      CommandID: params.commandId ?? "BusinessPayment",
      Amount: params.amount,
      PartyA: this.cfg.shortcode,
      PartyB: params.msisdn,
      Remarks: (params.remarks ?? "Chama payout").slice(0, 100),
      QueueTimeOutURL: `${this.cfg.callbackBase}/api/mpesa/b2c/timeout`,
      ResultURL: `${this.cfg.callbackBase}/api/mpesa/b2c/result`,
      Occasion: (params.occasion ?? "").slice(0, 100),
    };
    const headers = await this.authed();
    const { data } = await this.http.post(
      "/mpesa/b2c/v1/paymentrequest",
      body,
      { headers }
    );
    return data as B2CResponse;
  }

  /**
   * Query a transaction when the callback never arrived.
   */
  async transactionStatus(params: {
    transactionId: string;
    identifierType?: "1" | "2" | "4"; // 4 = shortcode
    originatorConversationId?: string;
  }): Promise<TxStatusResponse> {
    const body = {
      Initiator: this.cfg.initiatorName,
      SecurityCredential: this.cfg.initiatorPassword,
      CommandID: "TransactionStatusQuery",
      TransactionID: params.transactionId,
      OriginatorConversationID: params.originatorConversationId,
      PartyA: this.cfg.shortcode,
      IdentifierType: params.identifierType ?? "4",
      ResultURL: `${this.cfg.callbackBase}/api/mpesa/status/result`,
      QueueTimeOutURL: `${this.cfg.callbackBase}/api/mpesa/status/timeout`,
      Remarks: "Status check",
      Occasion: "",
    };
    const headers = await this.authed();
    const { data } = await this.http.post(
      "/mpesa/transactionstatus/v1/query",
      body,
      { headers }
    );
    return data as TxStatusResponse;
  }
}

export type StkPushResponse = {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string; // "0" on success queue
  ResponseDescription: string;
  CustomerMessage: string;
};

export type C2BRegisterResponse = {
  OriginatorCoversationID?: string;
  ResponseCode?: string;
  ResponseDescription?: string;
  ConversationID?: string;
};

export type B2CResponse = {
  ConversationID: string;
  OriginatorConversationID: string;
  ResponseCode: string;
  ResponseDescription: string;
};

export type TxStatusResponse = B2CResponse;

/**
 * Canonical account reference format: <PREFIX>-<yyyymm>[-<userId>]
 * Keeps matching deterministic even when members mistype.
 */
export function buildAccountRef(prefix: string, period: string, userId?: string) {
  const p = prefix.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  const parts = [p, period.replace(/[^0-9]/g, "")];
  if (userId) parts.push(userId.slice(0, 4));
  return parts.join("-").slice(0, 12);
}
