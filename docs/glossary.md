# Glossary

## Finance and budgeting

| Term | Meaning | In the code | Italian UI |
| --- | --- | --- | --- |
| Ready to assign | Money that has come in but has no job yet | `readyToAssign` | Da assegnare |
| Category | An "envelope" of the budget: Groceries, Rent, Fun… | `categoryId` | Categoria |
| Assigned | Money put into a category for a month | `assigned`, `Assignment` | Assegnato |
| Activity | Spending (negative) and refunds (positive) of a category in the month | `activity`, `Activity` | Movimenti |
| Available | Carried over + assigned + activity; negative = overspent | `available` | Disponibile |
| Carried over | Positive available balance from the previous month | `carriedOver` | Riportato |
| Cash overspending | The part of a negative category paid from cash accounts; taken from ready to assign the following month | `cashOverspending`, `overspentLastMonth` | Spesa eccessiva in contanti |
| Credit overspending | The part of a negative category paid with a credit card; it becomes card debt and does not touch ready to assign | `creditOverspending` | Spesa eccessiva con carta |
| Payment category | A category per credit card holding the money set aside to pay it; covered card spending moves money into it | `paymentCategoryId`, `paymentCategories` | Pagamento carta |
| Card payment | A transfer from a cash account to a credit card | `CardPayment` | Pagamento della carta |
| On-budget / off-budget account | Accounts whose money is (or is not) part of the budget; investments and mortgages are usually off-budget | `onBudget` | Conto in budget / fuori budget |
| Split | One transaction spread across several categories | `Split` | Suddivisione |
| Minor unit | The smallest unit of a currency: the cent for EUR, the yen for JPY | `Cents` | Centesimo |

## Technical

| Term | Meaning |
| --- | --- |
| Monorepo | One repository with several packages that depend on each other |
| Package | A folder with its own `package.json`: a library or an app |
| Pure function | A function that depends only on its parameters and has no external effects (database, network, files) |
| Invariant | A property that must always hold, whatever the data |
| Lockfile | `pnpm-lock.yaml`: the exact versions of every dependency, for identical installs everywhere |
| CI | Continuous integration: GitHub runs checks and tests on every change |
| ADR | Architecture Decision Record: a page explaining a decision and the discarded alternatives |
| Locale | Language and regional conventions for numbers and dates, for example `it-IT` or `en-US` |
| i18n | Internationalization: preparing the app to be translated and formatted for any locale |
