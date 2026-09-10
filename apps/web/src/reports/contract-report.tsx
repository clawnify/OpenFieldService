import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer";

export interface ContractPdfModel {
  identifier: string;
  versionNumber: number;
  title: string;
  body: string;
  effectiveOn: string | null;
  company: { name: string };
  customer: { name: string; email?: string | null; address?: string };
  commercial: {
    quoteIdentifier: string;
    optionName: string;
    lines: {
      description: string;
      quantityMilli: number;
      unit: string;
      unitPriceCents: number;
      totalCents: number;
    }[];
    subtotalCents: number;
    discountCents: number;
    taxCents: number;
    totalCents: number;
    currency: string;
    taxComponents: {
      name: string;
      rateBasisPoints: number;
      amountCents: number;
    }[];
  };
  signatures: {
    signerName: string;
    role: string;
    method: string;
    signedAt: string;
    ip: string | null;
    userAgent: string | null;
    imageDataUrl?: string;
  }[];
  documentHash: string;
}
const s = StyleSheet.create({
  page: {
    padding: 40,
    fontFamily: "Helvetica",
    fontSize: 10,
    color: "#172033",
  },
  header: { fontSize: 20, marginBottom: 4 },
  muted: { color: "#64748b", fontSize: 8 },
  section: { marginTop: 16 },
  row: {
    flexDirection: "row",
    borderBottom: "1 solid #e2e8f0",
    paddingVertical: 5,
  },
  grow: { flexGrow: 1 },
  money: { width: 80, textAlign: "right" },
  total: { fontSize: 13, fontWeight: 700, textAlign: "right", marginTop: 8 },
  body: { lineHeight: 1.5, marginTop: 8 },
  signature: { padding: 8, border: "1 solid #cbd5e1", marginTop: 8 },
});
const money = (cents: number, currency: string) =>
  `${currency} ${(cents / 100).toFixed(2)}`;
export function ContractReport({ model }: { model: ContractPdfModel }) {
  return (
    <Document title={`${model.identifier} signed agreement`}>
      <Page size="LETTER" style={s.page}>
        <Text style={s.header}>
          {model.company.name || "Open Fieldservice"}
        </Text>
        <Text>{model.title}</Text>
        <Text style={s.muted}>
          {model.identifier} · Version {model.versionNumber} · Source{" "}
          {model.commercial.quoteIdentifier}
        </Text>
        <View style={s.section}>
          <Text>Customer: {model.customer.name}</Text>
          {model.customer.email ? <Text>{model.customer.email}</Text> : null}
          {model.effectiveOn ? (
            <Text>Effective: {model.effectiveOn}</Text>
          ) : null}
        </View>
        <View style={s.section}>
          <Text style={{ fontSize: 13 }}>
            Commercial terms — {model.commercial.optionName}
          </Text>
          {model.commercial.lines.map((line, i) => (
            <View key={i} style={s.row}>
              <Text style={s.grow}>
                {line.description} · {(line.quantityMilli / 1000).toFixed(3)}{" "}
                {line.unit}
              </Text>
              <Text style={s.money}>
                {money(line.totalCents, model.commercial.currency)}
              </Text>
            </View>
          ))}
          <Text style={s.total}>
            Subtotal{" "}
            {money(model.commercial.subtotalCents, model.commercial.currency)}
          </Text>
          <Text style={s.total}>
            Discount −
            {money(model.commercial.discountCents, model.commercial.currency)}
          </Text>
          {model.commercial.taxComponents.map((tax, i) => (
            <Text key={i} style={s.total}>
              {tax.name} {(tax.rateBasisPoints / 100).toFixed(2)}%{" "}
              {money(tax.amountCents, model.commercial.currency)}
            </Text>
          ))}
          <Text style={s.total}>
            Total{" "}
            {money(model.commercial.totalCents, model.commercial.currency)}
          </Text>
        </View>
        <View style={s.section}>
          <Text style={{ fontSize: 13 }}>Agreement terms</Text>
          <Text style={s.body}>{model.body || "No additional terms."}</Text>
        </View>
        <View style={s.section}>
          <Text style={{ fontSize: 13 }}>Electronic signature certificate</Text>
          {model.signatures.map((signature, i) => (
            <View key={i} style={s.signature}>
              <Text>
                {signature.signerName} · {signature.role}
              </Text>
              {signature.imageDataUrl ? (
                // React PDF's Image is not a DOM image and has no alt prop.
                // eslint-disable-next-line jsx-a11y/alt-text
                <Image
                  src={signature.imageDataUrl}
                  style={{
                    width: 180,
                    height: 60,
                    objectFit: "contain",
                    marginVertical: 5,
                  }}
                />
              ) : null}
              <Text>
                Signed {signature.signedAt} using {signature.method}
              </Text>
              <Text style={s.muted}>
                IP: {signature.ip || "not captured"} · User agent:{" "}
                {signature.userAgent || "not captured"}
              </Text>
            </View>
          ))}
          <Text style={[s.muted, { marginTop: 8 }]}>
            Agreement fingerprint: {model.documentHash}. This is technical
            evidence, not legal advice regarding enforceability.
          </Text>
        </View>
      </Page>
    </Document>
  );
}
