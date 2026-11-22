# Translation glossary

The words the interface uses for the app's own concepts, in every language it is translated into, with the form of address and the tone of each language ([ADR 0015](../../docs/adr/0015-english-first-translations.md)). It is binding: the `translator` agent uses these terms in every catalog in `locales/`, and the `ux-reviewer` checks the screens against them.

- **What a term means** is defined once, in the domain glossary, [`docs/glossary.md`](../../docs/glossary.md), with the names the code uses. This file only says how each term is written in the interface, and is the one source for that in every language, Italian included.
- **Italian** is the approved copy: taken from `locales/it.json` and from the mockups in `docs/ux/mockups/` as they were approved in Italian, before #622 turned them into English (`git show be8c552:docs/ux/mockups/<file>`, recorded in `docs/ux/README.md`). The maintainer reviews this column.
- **The glossary wins over the archived mockup Italian.** Where the Italian of the mockups (at that last Italian commit) and this file disagree, this file is right, and so is `it.json` once it follows it. Superseded mockup wording: *Dividi su più categorie* and *Divisa su più categorie* (now *Suddividi su più categorie* and *Suddivisione su più categorie*), *Annulla divisione* (now *Annulla la suddivisione*), *Il portafoglio* or *Il tuo portafoglio* as the cash account's hint (now *I contanti che hai con te*), and *Frazionamento* for a transaction split (now only the stock split).
- **German, Spanish and French** were chosen by an agent and are reviewed only by agents; corrections are welcome.
- **Changing a term** changes every catalog string that uses it, in the same pull request. A new term with a domain meaning gets a row here, every column filled, in the same commit as the strings that use it.
- **Inflection:** each row gives the base form; inflect it as the sentence needs (German case, gender and number agreement in Italian, Spanish and French). The words in parentheses give the gender where it matters for agreement.

## Form of address

| Language | Form | Example (`budget.todo.overassigned.title`) |
| --- | --- | --- |
| English | *you* | You assigned more than you have |
| Italian | *tu* (informal) | Hai assegnato più di quanto hai |
| German | *du* (informal), lowercase inside a sentence; *dein*, *dir*, *dich* | Du hast mehr zugewiesen, als du hast |
| Spanish | *tú* (informal), never *usted*; *tu*, *tus* | Has asignado más de lo que tienes |
| French | *tu* (informal), never *vous*; *ton*, *ta*, *tes* | Tu as attribué plus que tu n’as |

The app speaks as *we* when it reports its own failure (`*.error`): "We could not load your budget." stays first person plural in every language: *Non siamo riusciti a…*, *Wir konnten … nicht …*, *No hemos podido…*, *Nous n’avons pas pu…*.

## Tone

Every language follows the same rule as the English (`CLAUDE.md`, "No advice"): the app states what the user's own targets and thresholds require and what an action does, never what the user should do, and never judges.

- No imperative, judgement or exclamation that the English does not have. An English imperative is a button or a field instruction ("Assign", "Enter an amount"), and stays one; an English statement stays a statement.
- No intensifiers or reassurance ("only", "just", "don't worry", "great") unless the English has them.
- Neutral framing of a correction: "To get back to your targets:" is *Per tornare ai tuoi obiettivi:*, *Um deine Ziele wieder zu erreichen:*, *Para volver a tus objetivos:*, *Pour revenir à tes objectifs :*.
- A problem is a fact with an amount ("{category} is negative by {amount}."), not a warning: no "Attention", "Achtung", "¡Cuidado!", "Attention !".

| Language | Notes |
| --- | --- |
| Italian | Short, plain, conversational: *Scrivi un importo* (not *Inserire un importo*); infinitive or impersonal forms only where the approved copy uses them. Field instructions use the imperative with *tu*: *Scegli*, *Scrivi*. Buttons use the imperative too (*Salva*, *Aggiungi*, *Annulla*), never the infinitive. Loading states: *Caricamento…*. |
| German | Imperative with *du* for instructions: *Gib einen Betrag ein*, *Wähle eine Kategorie*. Prefer the shorter of two wordings (screens are checked at 360 px); avoid long compounds when a short phrase is clearer. No *Sie*, and no impersonal infinitive instructions (*Betrag eingeben*) except on buttons, where the infinitive is the normal German form (*Speichern*, *Abbrechen*). Loading states: *Wird geladen…* or *… werden geladen…*. |
| Spanish | Imperative with *tú* for instructions: *Escribe un importe*, *Elige una categoría*. Buttons use the infinitive (*Guardar*, *Añadir*, *Cancelar*), the normal Spanish form; a button with an object keeps it (*Añadir cuenta*). Peninsular vocabulary where it differs (*importe*, *coste*), since the app's formats default to the device's region anyway. Loading states: *Cargando…*. |
| French | Imperative with *tu* for instructions: *Saisis un montant*, *Choisis une catégorie*. Buttons use the infinitive (*Enregistrer*, *Annuler*), the normal French form. Loading states: *Chargement…*. |

## Typography

| Language | Quotation marks | Apostrophe | Other |
| --- | --- | --- | --- |
| Italian | « » with no inner spaces (*«Da assegnare»*) | ’ (U+2019) | Never the straight ' in a string. |
| German | „ “ (*„Nicht zugewiesen“*) | ’ | Nouns capitalized; a label that is an adjective or participle starts with a capital (*Verfügbar*). |
| Spanish | « » with no inner spaces | ’ | Opening ¿ and ¡ where a question or exclamation occurs (the English has almost none). |
| French | « » with a no-break space inside (U+00A0 or U+202F) | ’ | A no-break space before `:` (U+00A0) and a narrow no-break space (U+202F) before `;`, `!`, `?`, never an ordinary space: *Dette à couvrir : {category}*. |

The app's name, *envelope*, is never translated or capitalized.

### Amounts and dates

No catalog writes a currency symbol, a decimal or grouping separator, a minus sign or a date itself: amounts go through `formatMoney` (`packages/core/src/money.ts`) and dates through the helpers in `apps/web/src/format.ts`, both `Intl`, and reach the message as an argument (`{amount}`, `{date}`). Only an example of how to type an amount (*20,00*, *1.234,56*) is written by hand, in the locale's own separators. What `Intl` produces for −1,234.56 EUR, −5.00 EUR and 5 September 2026 (`shortDate`), so a screen can be checked against it:

| Locale | −1,234.56 EUR | −5.00 EUR | `shortDate` | Notes |
| --- | --- | --- | --- | --- |
| `en-US` | -€1,234.56 | -€5.00 | Sep 5 | |
| `it-IT` | -1234,56 € | -5,00 € | 5 set | No grouping below 10,000; a no-break space (U+00A0) before € |
| `de-DE` | -1.234,56 € | -5,00 € | 5. Sept. | U+00A0 before € |
| `es-ES` | -1234,56 € | -5,00 € | 5 sept | No grouping below 10,000; U+00A0 before € |
| `fr-FR` | -1 234,56 € | -5,00 € | 5 sept. | A narrow no-break space (U+202F) groups thousands; U+00A0 before € |

The minus is the ASCII hyphen-minus in every locale. A message never adds its own space between an amount and a word that `Intl` already spaces.

### Plurals

Plural categories come from `Intl.PluralRules`, not from English. Every `plural` keeps `other`; add the categories the language has:

| Language | Categories | Notes |
| --- | --- | --- |
| English | `one`, `other` | |
| Italian | `one`, `many`, `other` | `many` is for large round numbers (1,000,000); it falls back to `other` if absent, so add it only when the wording differs (*1 milione di transazioni*). |
| German | `one`, `other` | |
| Spanish | `one`, `many`, `other` | As Italian: `many` for large round numbers (*1 millón de transacciones*). |
| French | `one`, `many`, `other` | **0 and 1 are both `one`** (*0 transaction*); `many` for large round numbers (*1 million de transactions*). |

## Terms

The tables write apostrophes straight (*d'imposta*) for easy searching; in a string, use the language's apostrophe from the table above.

### Budget

| English | Italian | German | Spanish | French | Notes |
| --- | --- | --- | --- | --- | --- |
| Budget | Budget | Budget | Presupuesto | Budget | The navigation entry and the plan itself |
| Workspace | Workspace (m.) | Workspace (m.) | Espacio de trabajo | Espace de travail | Italian and German keep the English word |
| Member | Membro | Mitglied | Miembro | Membre | A person in a workspace |
| Category (an "envelope") | Categoria | Kategorie | Categoría | Catégorie | Never *busta*, *Umschlag*, *sobre*, *enveloppe* in the interface |
| Group (of categories) | Gruppo | Gruppe | Grupo | Groupe | |
| Assign (money to a category) | Assegnare | Zuweisen | Asignar | Attribuer | Verb for budgeting only; not for the portfolio's target allocation |
| Assigned | Assegnato | Zugewiesen | Asignado | Attribué | "Assigned this month" |
| Unassigned (money not assigned yet) | Da assegnare | Nicht zugewiesen | Por asignar | À attribuer | As the name of the balance in running text, quoted and capitalized: *«Da assegnare»*, never *quelli non assegnati*. As a plain adjective it stays lowercase and unquoted: *{amount} sono arrivati e sono ancora da assegnare* (`budget.toast.unassigned`) |
| Available | Disponibile | Verfügbar | Disponible | Disponible | Also as a noun: *il disponibile*, *das Verfügbare*, *lo disponible*, *le disponible* |
| Activity | Movimenti (m. pl.) | Umsätze (pl.) | Movimientos | Mouvements | "No activity": *Nessun movimento*, *Keine Umsätze*, *Sin movimientos*, *Aucun mouvement* |
| Carried over | Riportato | Übertragen | Remanente | Reporté | *Riportato da agosto*, *Übertragen aus August*, *Remanente de agosto*, *Reporté d'août* |
| Spent | Speso | Ausgegeben | Gastado | Dépensé | |
| Overspent | Sforato | Überzogen | Excedido | Dépassé | Of a category: *categoria sforata*, *Kategorie überzogen*, *categoría excedida*, *catégorie dépassée* |
| Overspending | Sforamento | Überziehung | Exceso | Dépassement | |
| Overspent in cash | Sforato in contanti | Bar überzogen | Excedido en efectivo | Dépassé en espèces | Cash overspending |
| Overspent with a card | Sforato con la carta | Mit Karte überzogen | Excedido con tarjeta | Dépassé par carte | Credit overspending |
| Cover (overspending, a debt, a reservation) | Coprire | Ausgleichen (overspending), decken (debt, reservation) | Cubrir | Couvrir | *Copri {category}*, *{category} ausgleichen*, *Cubre {category}*, *Couvre {category}* |
| Debt (card debt) | Debito | Schuld (Kartenschuld) | Deuda | Dette | "Debt to cover" |
| Money | Soldi | Geld | Dinero | Argent | |
| Minor unit | Centesimo | Cent | Céntimo | Centime | The smallest unit of the currency (the cent for EUR); amounts themselves are formatted by `Intl`, never written by a catalog |
| Move money | Sposta soldi | Geld verschieben | Mover dinero | Déplacer de l'argent | |
| Quick assign | Assegnazione rapida | Schnellzuweisung | Asignación rápida | Attribution rapide | |
| Target (of a category) | Obiettivo | Ziel | Objetivo | Objectif | Also the portfolio's target allocation |
| Fund (a target) | Finanziare | Finanzieren | Financiar | Financer | "Fund all targets" |
| Underfunded | Da finanziare | Unterfinanziert | Por financiar | À financer | Filter tab |
| Threshold (a target's balance to keep) | Soglia | Schwelle | Umbral | Seuil | Also the portfolio's rebalancing threshold |
| Due month | Mese di scadenza | Fälligkeitsmonat | Mes de vencimiento | Mois d'échéance | |
| Scheduled (transactions) | Programmate (f. pl.) | Geplant | Programadas | Planifiées | Tab label; the side sheet is "Scheduled" |
| Scheduled transaction | Transazione programmata | Geplante Buchung | Transacción programada | Transaction planifiée | Of an expense: *spesa programmata*, *geplante Ausgabe*, *gasto programado*, *dépense planifiée* |
| Reserved | Prenotato | Reserviert | Reservado | Réservé | Money a scheduled transaction holds in its category |
| Reservation | Prenotazione | Reservierung | Reserva | Réservation | |
| Record (a scheduled transaction) | Registrare | Erfassen | Registrar | Enregistrer | *Registra {payee}*, *{payee} erfassen*, *Registra {payee}*, *Enregistre {payee}*; not *buchen* (see Transaction) |
| Days of buffer | Giorni di margine | Tage Puffer | Días de margen | Jours de marge | |
| To do (the list of problems) | Da fare | Zu erledigen | Por hacer | À faire | |
| Set aside (money for a card) | Messi da parte | Zurückgelegt | Apartado | Mis de côté | |
| Paid beyond what was set aside (a card paid more than its payment category held) | Pagato oltre i soldi messi da parte | Mehr bezahlt als zurückgelegt | Pagado por encima de lo apartado | Payé au-delà de l'argent mis de côté | The payment category's cash overspending (#699); neutral, never a warning. Italian agrees with the amount: *{amount} pagati oltre i soldi messi da parte* |
| Payment category | Categoria di pagamento | Zahlungskategorie | Categoría de pago | Catégorie de paiement | One per credit card |
| Credit card payments (the group) | Pagamenti delle carte di credito | Kreditkartenzahlungen | Pagos de tarjetas de crédito | Paiements des cartes de crédit | |
| Card payment (paying the card) | Pagamento della carta | Kartenausgleich | Pago de la tarjeta | Règlement de la carte | Not *Kartenzahlung*, which means paying *with* a card |
| Card spending | Spesa con la carta | Kartenausgaben | Gastos con tarjeta | Dépenses par carte | |

### Accounts

| English | Italian | German | Spanish | French | Notes |
| --- | --- | --- | --- | --- | --- |
| Account | Conto | Konto | Cuenta | Compte | |
| On budget | In budget | Im Budget | En el presupuesto | Dans le budget | *Conto in budget*, never *a budget* |
| Off budget | Fuori budget | Nicht im Budget | Fuera del presupuesto | Hors budget | |
| Checking | Conto corrente | Girokonto | Cuenta corriente | Compte courant | Account type |
| Savings | Risparmio | Sparkonto | Ahorro | Épargne | Account type |
| Cash | Contanti | Bargeld | Efectivo | Espèces | Account type, and "in cash". Never *portafoglio* in Italian: that is only the securities Portfolio |
| Credit card | Carta di credito | Kreditkarte | Tarjeta de crédito | Carte de crédit | Short form *carta*, *Karte*, *tarjeta*, *carte* |
| Brokerage (account) | Conto titoli | Depot | Cuenta de valores | Compte-titres | Always off budget |
| Wallet (the cash account's hint) | Contanti (*I contanti che hai con te*) | Geldbörse | Monedero | Porte-monnaie | Never the word used for Portfolio: Italian *portafoglio*, Spanish *cartera* and French *portefeuille* would clash |
| Balance | Saldo | Saldo | Saldo | Solde | |
| Starting balance | Saldo iniziale | Anfangssaldo | Saldo inicial | Solde initial | |
| Net worth | Patrimonio netto | Nettovermögen | Patrimonio neto | Patrimoine net | |
| Closed (account) | Chiuso | Geschlossen | Cerrada | Clôturé | |

### Transactions

| English | Italian | German | Spanish | French | Notes |
| --- | --- | --- | --- | --- | --- |
| Transaction | Transazione | Buchung | Transacción | Transaction | |
| Payee | Beneficiario | Empfänger | Beneficiario | Bénéficiaire | Also the payer of an inflow. Where a field's label depends on the direction, the mockups label an inflow's payee *Da chi* and a scheduled outflow's *A chi*: *Von wem* / *An wen*, *De quién* / *A quién*, *De qui* / *À qui*. No English key has that distinction yet; until one does, the label is *Beneficiario* |
| Memo | Nota | Notiz | Nota | Note | Never *Memo* in Italian |
| Inflow | Entrata | Eingang | Entrada | Entrée | Column and kind of transaction |
| Outflow | Uscita | Ausgang | Salida | Sortie | German *Ausgang*, so that *Ausgabe* stays Expense |
| Income | Entrata | Einnahme | Ingreso | Revenu | `import.check.income` is *Da assegnare* in Italian, since income lands there |
| Expense | Spesa | Ausgabe | Gasto | Dépense | "New expense" |
| Transfer (between accounts) | Trasferimento | Umbuchung | Transferencia | Virement | *Trasferimento da / verso {account}*, *Umbuchung von / auf {account}*, *Transferencia desde / hacia {account}*, *Virement depuis / vers {account}* |
| Split (a transaction across categories) | Suddivisione; *suddividere* as the verb | Aufteilung; *aufteilen* | División; *dividir* | Répartition; *répartir* | Action "Split across categories": *Suddividi su più categorie*; heading: *Suddivisione su più categorie*. Never *Frazionamento*, which is the stock split (maintainer decision, 2026-11-21) |
| Cleared | Verificata | Bestätigt | Confirmada | Pointée | Status of a transaction the bank shows. "Cleared against the bank": *Verificata con l'estratto conto* |
| Pending | In attesa | Ausstehend | Pendiente | En attente | Not cleared yet |
| Reconcile | Riconciliare | Abgleichen | Conciliar | Rapprocher | |
| Reconciliation | Riconciliazione | Abgleich | Conciliación | Rapprochement | |
| Reconciled | Riconciliata | Abgeglichen | Conciliada | Rapprochée | |
| Lock / unlock (a reconciled transaction) | Bloccare / sbloccare | Sperren / entsperren | Bloquear / desbloquear | Verrouiller / déverrouiller | |
| Adjustment (reconciliation) | Rettifica | Korrektur | Ajuste | Ajustement | |
| Tally (reconciliation) | Conteggio | Rechnung | Recuento | Décompte | "Put it back in the tally" |
| Tick / untick | Spuntare / togliere la spunta | Abhaken / Haken entfernen | Marcar / desmarcar | Cocher / décocher | |
| Bank statement | Estratto conto | Kontoauszug | Extracto | Relevé | |
| Statement balance | Saldo dell'estratto conto | Saldo laut Kontoauszug | Saldo del extracto | Solde du relevé | |
| Register (an account's transactions) | Registro | Buchungsliste | Registro | Registre | "Already in the register" |
| Import | Importare | Importieren | Importar | Importer | |
| Staged (an imported row waiting to be confirmed) | In sospeso | Zurückgestellt | En espera | En suspens | Not Pending, which is a bank status |
| Projected (balance) | Previsto | Voraussichtlich | Previsto | Prévu | |
| Later (transactions dated after today) | Più avanti | Später | Más adelante | Plus tard | The register's section of rows dated after today, not in today's balance yet. Not Scheduled, which is a scheduled transaction not recorded yet |

### Portfolio

| English | Italian | German | Spanish | French | Notes |
| --- | --- | --- | --- | --- | --- |
| Portfolio | Portafoglio | Portfolio | Cartera | Portefeuille | |
| Instrument | Strumento | Wertpapier | Valor | Titre | |
| Securities | Titoli | Wertpapiere | Valores | Titres | |
| ISIN | Codice ISIN | ISIN | ISIN | Code ISIN | |
| Ticker | Ticker | Kürzel | Ticker | Symbole | |
| Market identifier code (MIC) | Codice del mercato (MIC) | Börsencode (MIC) | Código de mercado (MIC) | Code de marché (MIC) | |
| Trade | Operazione | Vorgang | Operación | Opération | A buy, sell, dividend, fee, stock split or transfer of securities |
| Buy / sell | Acquisto / vendita | Kauf / Verkauf | Compra / venta | Achat / vente | |
| Dividend | Dividendo | Dividende | Dividendo | Dividende | |
| Coupon | Cedola | Kupon | Cupón | Coupon | |
| Fee | Commissione | Gebühr | Comisión | Frais (m. pl.) | |
| Stock split | Frazionamento | Aktiensplit | Split de acciones | Division d'actions | Not the split of a transaction across categories (*Suddivisione*) (maintainer decision, 2026-11-21) |
| Transfer of securities | Trasferimento titoli | Depotübertrag | Traspaso de valores | Transfert de titres | |
| Quantity (units held or traded) | Quote (f. pl.) | Stück | Participaciones | Parts | The interface term for the number of units: column headers, the trade form, positions (*Quote*, as in the portfolio mockup). *Quantità* stays the domain word in `docs/glossary.md` and is not used in the interface. For a bond quoted in percent the quantity is its nominal: label it *Valore nominale* (see Nominal) |
| Price | Prezzo | Kurs | Precio | Cours | |
| Price factor | Fattore di prezzo | Kursfaktor | Factor de precio | Facteur de prix | |
| Nominal | Valore nominale | Nennwert | Valor nominal | Valeur nominale | |
| Ex-date | Data di stacco | Ex-Tag | Fecha ex | Date de détachement | |
| Settlement | Regolamento | Abwicklung | Liquidación | Règlement | |
| Cash leg | Movimento di liquidità | Geldbuchung | Movimiento de efectivo | Mouvement d'espèces | |
| Cash (in a brokerage account) | Liquidità | Guthaben | Liquidez | Liquidités | |
| Position | Posizione | Position | Posición | Position | |
| Weighted average cost | Costo medio ponderato | Gewichtete Durchschnittskosten | Coste medio ponderado | Coût moyen pondéré | |
| Cost basis | Costo di carico | Einstandswert | Coste de adquisición | Prix de revient | |
| Gain | Guadagno | Gewinn | Ganancia | Gain | |
| Realized gain or loss | Plusvalenza o minusvalenza realizzata | Realisierter Gewinn oder Verlust | Ganancia o pérdida realizada | Plus-value ou moins-value réalisée | |
| Contributed | Versato | Eingezahlt | Aportado | Versé | |
| Return | Rendimento | Rendite | Rentabilidad | Rendement | |
| Accrued interest | Rateo di interessi | Stückzinsen | Cupón corrido | Coupon couru | |
| Income, costs, taxes on gains | Proventi, costi, imposte sulle plusvalenze | Erträge, Kosten, Steuern auf Gewinne | Rendimientos, costes, impuestos sobre ganancias | Revenus, coûts, impôts sur les plus-values | |
| Target allocation | Allocazione | Zielgewichtung | Distribución objetivo | Allocation cible | Not *asignación* in Spanish, nor *Aufteilung* in German: those are Assign and Split |
| Rebalancing | Ribilanciamento | Rebalancing | Rebalanceo | Rééquilibrage | |

### Italian taxes

Shown only in a workspace whose tax country is Italy; the terms name Italian concepts, so the other languages describe them rather than borrow a home-country equivalent.

| English | Italian | German | Spanish | French | Notes |
| --- | --- | --- | --- | --- | --- |
| Tax country | Paese fiscale | Steuerland | País de residencia fiscal | Pays de résidence fiscale | |
| Tax regime | Regime fiscale | Steuerregime | Régimen fiscal | Régime fiscal | |
| Self-declared (regime) | Dichiarativo | Selbst erklärt | Declarativo | Déclaratif | |
| Administered (regime) | Amministrato | Administriert | Administrado | Administré | |
| Managed (regime) | Gestito | Verwaltet | Gestionado | Géré | |
| Withholding agent | Sostituto d'imposta | Steuerabzugsstelle | Agente de retención | Agent de retenue | "The broker is an Italian withholding agent" |
| Domestic withholding | Ritenuta italiana | Italienische Quellensteuer | Retención italiana | Retenue à la source italienne | |
| Foreign withholding | Ritenuta estera | Ausländische Quellensteuer | Retención extranjera | Retenue à la source étrangère | |
| Gain tax | Imposta sulla plusvalenza | Steuer auf Kursgewinne | Impuesto sobre ganancias | Impôt sur les plus-values | |
| Gain tax adjustment | Rettifica dell'imposta sulle plusvalenze | Korrektur der Steuer auf Kursgewinne | Ajuste del impuesto sobre ganancias | Ajustement de l'impôt sur les plus-values | |
| Managed result tax | Imposta sul risultato di gestione | Steuer auf das Verwaltungsergebnis | Impuesto sobre el resultado de gestión | Impôt sur le résultat de gestion | |
| Stamp duty | Imposta di bollo | Stempelsteuer | Impuesto de timbre | Droit de timbre | |
| Financial transaction tax | Imposta sulle transazioni finanziarie | Finanztransaktionssteuer | Impuesto sobre las transacciones financieras | Taxe sur les transactions financières | |
| Dossier | Dossier titoli | Depot | Depósito de valores | Compte-titres | One securities account at a broker |
| Tax return | Dichiarazione dei redditi | Steuererklärung | Declaración de la renta | Déclaration de revenus | |

### Sign-in and settings

| English | Italian | German | Spanish | French | Notes |
| --- | --- | --- | --- | --- | --- |
| Sign in | Accedi | Anmelden | Iniciar sesión | Se connecter | |
| Sign out | Esci | Abmelden | Cerrar sesión | Se déconnecter | |
| Workspace settings | Impostazioni del workspace | Workspace-Einstellungen | Ajustes del espacio de trabajo | Paramètres de l'espace de travail | |
| Currency | Valuta | Währung | Moneda | Devise | |
| Exchange rate | Tasso di cambio | Wechselkurs | Tipo de cambio | Taux de change | Between two currencies; *mancano ancora i tassi di cambio*, *noch keine Wechselkurse*, *aún sin tipos de cambio*, *pas encore de taux de change* |
| Time zone | Fuso orario | Zeitzone | Zona horaria | Fuseau horaire | |
| Archive | Archiviare | Archivieren | Archivar | Archiver | Categories and groups |
