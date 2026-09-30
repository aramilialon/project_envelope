import type { CsvDateFormat, CsvMapping, DecimalSeparator } from "@envelope/core";
import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler, requireWriteAccess } from "../auth/workspace-membership.ts";
import { listCategories } from "../categories/repository.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfValidationError } from "../errors.ts";
import {
  confirmStagedTransactions,
  getImportMapping,
  listStagedTransactions,
  saveImportMapping,
  stageCsvImport,
  stageOfxImport,
  type StagedTransactionDecision,
  type StageImportResult,
} from "../import/repository.ts";

const DATE_FORMATS: readonly CsvDateFormat[] = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"];
const DECIMAL_SEPARATORS: readonly DecimalSeparator[] = [".", ","];
const IMPORT_FORMATS = ["csv", "ofx"] as const;
type ImportFormat = (typeof IMPORT_FORMATS)[number];

function parseMapping(body: Record<string, unknown>): CsvMapping | undefined {
  const { hasHeaderRow, dateColumn, dateFormat, descriptionColumn, decimalSeparator, memoColumn, amountColumn, outflowColumn, inflowColumn } =
    body;
  if (typeof hasHeaderRow !== "boolean") return undefined;
  if (typeof dateColumn !== "number") return undefined;
  if (typeof dateFormat !== "string" || !DATE_FORMATS.includes(dateFormat as CsvDateFormat)) return undefined;
  if (typeof descriptionColumn !== "number") return undefined;
  if (typeof decimalSeparator !== "string" || !DECIMAL_SEPARATORS.includes(decimalSeparator as DecimalSeparator)) return undefined;

  const shared = {
    hasHeaderRow,
    dateColumn,
    dateFormat: dateFormat as CsvDateFormat,
    descriptionColumn,
    decimalSeparator: decimalSeparator as DecimalSeparator,
    ...(typeof memoColumn === "number" ? { memoColumn } : {}),
  };
  if (typeof amountColumn === "number") {
    return { ...shared, amountColumn };
  }
  if (typeof outflowColumn === "number" && typeof inflowColumn === "number") {
    return { ...shared, outflowColumn, inflowColumn };
  }
  return undefined;
}

function parseDecisions(body: Record<string, unknown>): StagedTransactionDecision[] | undefined {
  const raw = body.decisions;
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const decisions: StagedTransactionDecision[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      return undefined;
    }
    const { stagedTransactionId, kind, categoryId, otherAccountId } = item as Record<string, unknown>;
    if (typeof stagedTransactionId !== "string") {
      return undefined;
    }
    if (kind === "income") {
      decisions.push({ stagedTransactionId, kind: "income" });
    } else if (kind === "category" && typeof categoryId === "string") {
      decisions.push({ stagedTransactionId, kind: "category", categoryId });
    } else if (kind === "transfer" && typeof otherAccountId === "string") {
      decisions.push({ stagedTransactionId, kind: "transfer", otherAccountId });
    } else {
      // No category, transfer or income recognition: blocks only this row's confirmation, not the whole batch.
      decisions.push({ stagedTransactionId, kind: "invalid" });
    }
  }
  return decisions;
}

export function registerImportRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);
  const writePreHandler = [preHandler, requireWriteAccess];
  const base = "/workspaces/:workspaceId/accounts/:accountId";

  app.put(`${base}/import-mapping`, { preHandler: writePreHandler }, async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const mapping = parseMapping(body);
    if (!mapping) {
      await reply.code(400).send({ error: "invalid CSV mapping" });
      return;
    }
    return saveImportMapping(request.db!, request.workspace!.id, accountId, mapping);
  });

  app.get(`${base}/import-mapping`, { preHandler }, async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const mapping = await getImportMapping(request.db!, request.workspace!.id, accountId);
    if (!mapping) {
      await reply.code(404).send({ error: "no import mapping saved for this account" });
      return;
    }
    return mapping;
  });

  app.post(`${base}/import`, { preHandler: writePreHandler }, async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const content = typeof body.content === "string" ? body.content : "";
    if (!content) {
      await reply.code(400).send({ error: "invalid import: content is required" });
      return;
    }
    const format: ImportFormat =
      typeof body.format === "string" && IMPORT_FORMATS.includes(body.format as ImportFormat)
        ? (body.format as ImportFormat)
        : "csv";
    const closingBalanceCents = typeof body.closingBalanceCents === "number" ? body.closingBalanceCents : undefined;

    try {
      let result: StageImportResult;
      if (format === "ofx") {
        result = await stageOfxImport(request.db!, request.workspace!.id, accountId, content, closingBalanceCents);
      } else {
        const mapping =
          body.mapping !== undefined
            ? parseMapping(body.mapping as Record<string, unknown>)
            : await getImportMapping(request.db!, request.workspace!.id, accountId);
        if (!mapping) {
          await reply.code(400).send({ error: "no CSV mapping given, and none saved for this account" });
          return;
        }
        result = await stageCsvImport(request.db!, request.workspace!.id, accountId, content, mapping, closingBalanceCents);
      }
      await reply.code(201).send(result);
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  app.get(`${base}/staged-transactions`, { preHandler }, async (request) => {
    const { accountId } = request.params as { accountId: string };
    const staged = await listStagedTransactions(request.db!, request.workspace!.id, accountId);
    return { staged };
  });

  app.post(`${base}/staged-transactions/confirm`, { preHandler: writePreHandler }, async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const decisions = parseDecisions(body);
    if (!decisions) {
      await reply.code(400).send({ error: "invalid confirmation: a non-empty decisions array is required" });
      return;
    }

    const categoryIdsToCheck = decisions.filter((d) => d.kind === "category").map((d) => d.categoryId);
    if (categoryIdsToCheck.length > 0) {
      const categories = await listCategories(request.db!, request.workspace!.id);
      const knownCategoryIds = new Set(categories.map((c) => c.id));
      const unknownCategoryId = categoryIdsToCheck.find((id) => !knownCategoryIds.has(id));
      if (unknownCategoryId) {
        await reply.code(400).send({ error: `categoryId "${unknownCategoryId}" does not name a category of this workspace` });
        return;
      }
    }

    const outcomes = await confirmStagedTransactions(request.db!, request.workspace!.id, accountId, decisions);
    return { outcomes };
  });
}
