import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { parseInput } from "@/lib/validation";
import { createCompanySchema } from "@/modules/companies/company.schema";
import { createContactSchema } from "@/modules/contacts/contact.schema";
import { createCustomerSchema, customerFilterSchema } from "@/modules/customers/customer.schema";

describe("CRM boundary validation", () => {
  it("rejects client-supplied ownership fields", () => expect(() => parseInput(createCustomerSchema, { name: "Injected", organizationId: crypto.randomUUID() })).toThrow(ValidationError));
  it("requires a contact parent", () => expect(() => parseInput(createContactSchema, { firstName: "No", lastName: "Parent" })).toThrow(ValidationError));
  it("rejects malformed company websites", () => expect(() => parseInput(createCompanySchema, { name: "Example", website: "not a url" })).toThrow(ValidationError));
  it("bounds customer page sizes", () => expect(() => parseInput(customerFilterSchema, { page: 1, pageSize: 101 })).toThrow(ValidationError));
});
