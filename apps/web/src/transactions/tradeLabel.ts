import { formatQuantity, toQuantity } from "@envelope/core";
import type { IntlShape } from "react-intl";

import type { TransactionTrade } from "./api.ts";

/** How an instrument reads in a short label: its ticker, as the portfolio screen shows it, or its name when it has none (a private instrument). */
function instrumentOf(trade: TransactionTrade): string | null {
  return trade.instrumentTicker ?? trade.instrumentName;
}

/**
 * A trade's cash leg as its trade (#657, ADR 0012): "Buy · 10 × WEQ", "Dividend · WEQ", or
 * "Fee" for an account-wide fee. One whole message per type, so each language orders its own
 * words. Shown in the account register's category cell and in reconciliation, where an
 * off-budget account's rows otherwise have nothing to say what they are.
 */
export function tradeLabel(intl: IntlShape, trade: TransactionTrade): string {
  const instrument = instrumentOf(trade);
  const quantity = formatQuantity(toQuantity(trade.quantityE8), { locale: intl.locale });
  switch (trade.type) {
    case "buy":
      return instrument === null
        ? intl.formatMessage({ id: "trade.label.buyNoInstrument", defaultMessage: "Buy" })
        : intl.formatMessage({ id: "trade.label.buy", defaultMessage: "Buy · {quantity} × {instrument}" }, { quantity, instrument });
    case "sell":
      return instrument === null
        ? intl.formatMessage({ id: "trade.label.sellNoInstrument", defaultMessage: "Sell" })
        : intl.formatMessage({ id: "trade.label.sell", defaultMessage: "Sell · {quantity} × {instrument}" }, { quantity, instrument });
    case "dividend":
      return instrument === null
        ? intl.formatMessage({ id: "trade.label.dividendNoInstrument", defaultMessage: "Dividend" })
        : intl.formatMessage({ id: "trade.label.dividend", defaultMessage: "Dividend · {instrument}" }, { instrument });
    case "fee":
      return instrument === null
        ? intl.formatMessage({ id: "trade.label.feeNoInstrument", defaultMessage: "Fee" })
        : intl.formatMessage({ id: "trade.label.fee", defaultMessage: "Fee · {instrument}" }, { instrument });
    case "tax":
      return instrument === null
        ? intl.formatMessage({ id: "trade.label.taxNoInstrument", defaultMessage: "Tax" })
        : intl.formatMessage({ id: "trade.label.tax", defaultMessage: "Tax · {instrument}" }, { instrument });
    case "split":
      return instrument === null
        ? intl.formatMessage({ id: "trade.label.splitNoInstrument", defaultMessage: "Stock split" })
        : intl.formatMessage({ id: "trade.label.split", defaultMessage: "Stock split · {instrument}" }, { instrument });
    case "transfer":
      return instrument === null
        ? intl.formatMessage({ id: "trade.label.transferNoInstrument", defaultMessage: "Transfer of securities" })
        : intl.formatMessage({ id: "trade.label.transfer", defaultMessage: "Transfer of securities · {instrument}" }, { instrument });
  }
}
