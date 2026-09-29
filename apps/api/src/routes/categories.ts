import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler, requireWriteAccess } from "../auth/workspace-membership.ts";
import {
  archiveCategory,
  archiveCategoryGroup,
  createCategory,
  createCategoryGroup,
  getCategoryGroup,
  listCategories,
  listCategoryGroups,
  reorderCategories,
  reorderCategoryGroups,
} from "../categories/repository.ts";
import type { DbPool } from "../db/pool.ts";

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === "string" ? value.trim() : "";
}

function stringArrayField(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return undefined;
  }
  return value;
}

export function registerCategoriesRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);
  const writePreHandler = [preHandler, requireWriteAccess];

  app.post("/workspaces/:workspaceId/category-groups", { preHandler: writePreHandler }, async (request, reply) => {
    const name = stringField((request.body ?? {}) as Record<string, unknown>, "name");
    if (!name) {
      await reply.code(400).send({ error: "invalid category group: name is required" });
      return;
    }
    const group = await createCategoryGroup(request.db!, request.workspace!.id, name);
    await reply.code(201).send(group);
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
    const group = await getCategoryGroup(request.db!, request.workspace!.id, groupId);
    if (!group) {
      await reply.code(400).send({ error: "groupId does not name a category group of this workspace" });
      return;
    }
    const category = await createCategory(request.db!, request.workspace!.id, groupId, name);
    await reply.code(201).send(category);
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
