import { MAX_NAME_LENGTH } from "@envelope/core";
import type { FastifyInstance } from "fastify";

import { PAYMENT_CATEGORY_GROUP_NAME } from "../accounts/repository.ts";
import { createWorkspaceMembershipPreHandler, withWriteAccess } from "../auth/workspace-membership.ts";
import {
  archiveCategory,
  archiveCategoryGroup,
  createCategory,
  createCategoryGroup,
  getCategory,
  getCategoryGroup,
  isCategoryGroupNameTaken,
  isCategoryNameTaken,
  isPaymentCategory,
  listCategories,
  listCategoryGroups,
  reorderCategories,
  reorderCategoryGroups,
  renameCategory,
  renameCategoryGroup,
} from "../categories/repository.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfTextTooLong } from "../errors.ts";

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === "string" ? value.trim() : "";
}

function isPaymentGroupName(name: string): boolean {
  return name.trim().toLowerCase() === PAYMENT_CATEGORY_GROUP_NAME.toLowerCase();
}

/**
 * A 409's own `code` (#397), so a client can say which conflict it was without matching on the
 * English `error` text: `name_taken` (another non-archived sibling already has that name),
 * `payment_category` (a card's own payment category, named after its card) or `payment_group`
 * (the shared "Credit card payments" group, found by that exact name when a card is created).
 */
type CategoryConflict = "name_taken" | "payment_category" | "payment_group";

function stringArrayField(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return undefined;
  }
  return value;
}

export function registerCategoriesRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);
  const writePreHandler = withWriteAccess(preHandler);

  app.post("/workspaces/:workspaceId/category-groups", { preHandler: writePreHandler }, async (request, reply) => {
    const name = stringField((request.body ?? {}) as Record<string, unknown>, "name");
    if (!name) {
      await reply.code(400).send({ error: "invalid category group: name is required" });
      return;
    }
    if (await sendIfTextTooLong(reply, [["name", name, MAX_NAME_LENGTH]])) {
      return;
    }
    if (await isCategoryGroupNameTaken(request.db!, request.workspace!.id, name)) {
      await reply.code(409).send({ error: "another category group already has this name", code: "name_taken" satisfies CategoryConflict });
      return;
    }
    const group = await createCategoryGroup(request.db!, request.workspace!.id, name);
    await reply.code(201).send(group);
  });

  app.patch("/workspaces/:workspaceId/category-groups/:groupId", { preHandler: writePreHandler }, async (request, reply) => {
    const { groupId } = request.params as { groupId: string };
    const name = stringField((request.body ?? {}) as Record<string, unknown>, "name");
    if (!name) {
      await reply.code(400).send({ error: "invalid category group: name is required" });
      return;
    }
    if (await sendIfTextTooLong(reply, [["name", name, MAX_NAME_LENGTH]])) {
      return;
    }
    const group = await getCategoryGroup(request.db!, request.workspace!.id, groupId);
    if (!group) {
      await reply.code(404).send({ error: "category group not found" });
      return;
    }
    if (isPaymentGroupName(group.name) || isPaymentGroupName(name)) {
      await reply.code(409).send({ error: "the credit card payments group keeps its own name", code: "payment_group" satisfies CategoryConflict });
      return;
    }
    if (await isCategoryGroupNameTaken(request.db!, request.workspace!.id, name, groupId)) {
      await reply.code(409).send({ error: "another category group already has this name", code: "name_taken" satisfies CategoryConflict });
      return;
    }
    return renameCategoryGroup(request.db!, request.workspace!.id, groupId, name);
  });

  app.get("/workspaces/:workspaceId/category-groups", { preHandler }, async (request) => {
    const groups = await listCategoryGroups(request.db!, request.workspace!.id);
    return { groups };
  });

  app.patch("/workspaces/:workspaceId/category-groups/:groupId/archive", { preHandler: writePreHandler }, async (request, reply) => {
    const { groupId } = request.params as { groupId: string };
    const group = await archiveCategoryGroup(request.db!, request.workspace!.id, groupId);
    if (!group) {
      await reply.code(404).send({ error: "category group not found" });
      return;
    }
    return group;
  });

  app.put("/workspaces/:workspaceId/category-groups/reorder", { preHandler: writePreHandler }, async (request, reply) => {
    const groupIds = stringArrayField((request.body ?? {}) as Record<string, unknown>, "groupIds");
    if (!groupIds) {
      await reply.code(400).send({ error: "groupIds must be an array of ids" });
      return;
    }
    const ok = await reorderCategoryGroups(request.db!, request.workspace!.id, groupIds);
    if (!ok) {
      await reply.code(400).send({ error: "groupIds must be exactly the workspace's current category groups" });
      return;
    }
    const groups = await listCategoryGroups(request.db!, request.workspace!.id);
    return { groups };
  });

  app.post("/workspaces/:workspaceId/categories", { preHandler: writePreHandler }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = stringField(body, "name");
    const groupId = stringField(body, "groupId");
    if (!name || !groupId) {
      await reply.code(400).send({ error: "invalid category: name and groupId are required" });
      return;
    }
    if (await sendIfTextTooLong(reply, [["name", name, MAX_NAME_LENGTH]])) {
      return;
    }
    const group = await getCategoryGroup(request.db!, request.workspace!.id, groupId);
    if (!group) {
      await reply.code(400).send({ error: "groupId does not name a category group of this workspace" });
      return;
    }
    if (await isCategoryNameTaken(request.db!, request.workspace!.id, groupId, name)) {
      await reply.code(409).send({ error: "another category in this group already has this name", code: "name_taken" satisfies CategoryConflict });
      return;
    }
    const category = await createCategory(request.db!, request.workspace!.id, groupId, name);
    await reply.code(201).send(category);
  });

  app.patch("/workspaces/:workspaceId/categories/:categoryId", { preHandler: writePreHandler }, async (request, reply) => {
    const { categoryId } = request.params as { categoryId: string };
    const name = stringField((request.body ?? {}) as Record<string, unknown>, "name");
    if (!name) {
      await reply.code(400).send({ error: "invalid category: name is required" });
      return;
    }
    if (await sendIfTextTooLong(reply, [["name", name, MAX_NAME_LENGTH]])) {
      return;
    }
    const category = await getCategory(request.db!, request.workspace!.id, categoryId);
    if (!category) {
      await reply.code(404).send({ error: "category not found" });
      return;
    }
    if (await isPaymentCategory(request.db!, request.workspace!.id, categoryId)) {
      await reply.code(409).send({ error: "a card's payment category is named after its card", code: "payment_category" satisfies CategoryConflict });
      return;
    }
    if (await isCategoryNameTaken(request.db!, request.workspace!.id, category.groupId, name, categoryId)) {
      await reply.code(409).send({ error: "another category in this group already has this name", code: "name_taken" satisfies CategoryConflict });
      return;
    }
    return renameCategory(request.db!, request.workspace!.id, categoryId, name);
  });

  app.get("/workspaces/:workspaceId/categories", { preHandler }, async (request) => {
    const categories = await listCategories(request.db!, request.workspace!.id);
    return { categories };
  });

  app.patch("/workspaces/:workspaceId/categories/:categoryId/archive", { preHandler: writePreHandler }, async (request, reply) => {
    const { categoryId } = request.params as { categoryId: string };
    const category = await archiveCategory(request.db!, request.workspace!.id, categoryId);
    if (!category) {
      await reply.code(404).send({ error: "category not found" });
      return;
    }
    return category;
  });

  app.put(
    "/workspaces/:workspaceId/category-groups/:groupId/categories/reorder",
    { preHandler: writePreHandler },
    async (request, reply) => {
      const { groupId } = request.params as { groupId: string };
      const categoryIds = stringArrayField((request.body ?? {}) as Record<string, unknown>, "categoryIds");
      if (!categoryIds) {
        await reply.code(400).send({ error: "categoryIds must be an array of ids" });
        return;
      }
      const ok = await reorderCategories(request.db!, request.workspace!.id, groupId, categoryIds);
      if (!ok) {
        await reply.code(400).send({ error: "categoryIds must be exactly this group's current categories" });
        return;
      }
      const categories = await listCategories(request.db!, request.workspace!.id);
      return { categories: categories.filter((c) => c.groupId === groupId) };
    },
  );
}
