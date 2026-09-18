import { describe, expect, it } from "vitest";
import {
  ContentCredentialsSchema,
  makeIndeterminateResult,
  resultLabel,
  type ContentCredentials,
} from "../src/index.js";

const credentials: ContentCredentials = {
  status: "verified",
  signatureValid: true,
  contentBindingValid: true,
  signerTrusted: false,
  issuer: "Test signer",
  actions: [],
  aiDeclaration: "generated",
  validationCodes: [],
  trustListVersion: "6273cdcb4f27",
};

describe("credential result labels", () => {
  it("keeps an untrusted AI declaration distinct from a trusted signer", () => {
    const result = {
      ...makeIndeterminateResult("OpenAI is unavailable."),
      contentCredentials: credentials,
    };
    expect(resultLabel(result)).toBe(
      "AI generation declared by an untrusted signer",
    );
    expect(
      resultLabel({
        ...result,
        contentCredentials: { ...credentials, signerTrusted: true },
      }),
    ).toBe("AI generation declared in trusted Content Credentials");
    expect(
      resultLabel({
        ...result,
        contentCredentials: { ...credentials, aiDeclaration: null },
      }),
    ).toBe("Content Credentials verified");
  });

  it("rejects contradictory credential evidence before display or storage", () => {
    expect(
      ContentCredentialsSchema.safeParse({
        ...credentials,
        signatureValid: false,
      }).success,
    ).toBe(false);
    expect(
      ContentCredentialsSchema.safeParse({
        ...credentials,
        status: "invalid",
        signerTrusted: true,
      }).success,
    ).toBe(false);
  });
});
