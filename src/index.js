const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function requireAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  return Boolean(env.ADMIN_TOKEN) && auth === `Bearer ${env.ADMIN_TOKEN}`;
}

const mediaTypes = new Set(["image", "video", "youtube"]);

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function valueOrCurrent(body, key, current) {
  return body[key] !== undefined ? body[key] : current[key];
}

function toFeatured(value, fallback) {
  if (value === undefined) return fallback;
  return value ? 1 : 0;
}

function toInteger(value, fallback = 0) {
  if (value === undefined) return fallback;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function toId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeTechnologies(value) {
  if (value === null || value === undefined || value === "") return [];

  let items = value;
  if (typeof value === "string") {
    try {
      items = JSON.parse(value);
    } catch {
      items = value.split(",");
    }
  }

  if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) {
    return null;
  }

  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function serializeTechnologies(value) {
  const technologies = normalizeTechnologies(value);
  return technologies === null ? null : JSON.stringify(technologies);
}

function formatProject(project) {
  if (!project) return project;
  return {
    ...project,
    technologies: normalizeTechnologies(project.technologies) || [],
  };
}

function validateMedia(input, current = null) {
  const media = {
    type: String(valueOrCurrent(input, "type", current || {}) || "").trim(),
    url: String(valueOrCurrent(input, "url", current || {}) || "").trim(),
    thumbnail_url: String(valueOrCurrent(input, "thumbnail_url", current || {}) || "").trim(),
    title: String(valueOrCurrent(input, "title", current || {}) || "").trim(),
    caption: String(valueOrCurrent(input, "caption", current || {}) || "").trim(),
    sort_order: toInteger(input.sort_order, current?.sort_order ?? 0),
  };

  if (!mediaTypes.has(media.type)) {
    return { error: "type must be image, video or youtube" };
  }
  if (!media.url) {
    return { error: "url is required" };
  }
  if (media.sort_order === null) {
    return { error: "sort_order must be an integer" };
  }

  return { media };
}

async function getProjectIdBySlug(env, slug) {
  if (!slug) return null;

  const project = await env.DB.prepare(`
    SELECT id FROM projects
    WHERE slug = ?
    LIMIT 1
  `).bind(slug).first();

  return project?.id ?? null;
}

async function getProjectById(env, id) {
  return await env.DB.prepare(`
    SELECT *
    FROM projects
    WHERE id = ?
    LIMIT 1
  `).bind(id).first();
}

async function getProjectMedia(env, projectId) {
  return await env.DB.prepare(`
    SELECT *
    FROM project_media
    WHERE project_id = ?
    ORDER BY sort_order ASC, created_at ASC, id ASC
  `).bind(projectId).all();
}

async function getProjectMediaById(env, projectId, mediaId) {
  return await env.DB.prepare(`
    SELECT *
    FROM project_media
    WHERE id = ? AND project_id = ?
    LIMIT 1
  `).bind(mediaId, projectId).first();
}

async function touchProject(env, projectId) {
  await env.DB.prepare(`
    UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(projectId).run();
}

async function getNewsById(env, id) {
  return await env.DB.prepare(`
    SELECT
      news.*,
      projects.slug AS project_slug,
      projects.title AS project_title
    FROM news
    LEFT JOIN projects ON projects.id = news.project_id
    WHERE news.id = ?
    LIMIT 1
  `).bind(id).first();
}

async function handleProjectMediaRequest(request, env, pathname) {
  const collectionMatch = pathname.match(/^\/admin\/projects\/(\d+)\/media\/?$/);
  const reorderMatch = pathname.match(/^\/admin\/projects\/(\d+)\/media\/reorder\/?$/);
  const itemMatch = pathname.match(/^\/admin\/projects\/(\d+)\/media\/(\d+)\/?$/);
  const routeMatch = reorderMatch || itemMatch || collectionMatch;

  if (!routeMatch) return null;

  if (!requireAdmin(request, env)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const projectId = toId(routeMatch[1]);
  if (!projectId) {
    return json({ ok: false, error: "Invalid project id" }, 400);
  }

  const project = await getProjectById(env, projectId);
  if (!project) {
    return json({ ok: false, error: "Project not found" }, 404);
  }

  if (collectionMatch && request.method === "GET") {
    const result = await getProjectMedia(env, projectId);
    return json({ ok: true, media: result.results });
  }

  if (collectionMatch && request.method === "POST") {
    const body = await request.json();

    if (body.sort_order === undefined) {
      const last = await env.DB.prepare(`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
        FROM project_media
        WHERE project_id = ?
      `).bind(projectId).first();
      body.sort_order = last.next_sort_order;
    }

    const validated = validateMedia(body);
    if (validated.error) {
      return json({ ok: false, error: validated.error }, 400);
    }

    const media = validated.media;
    const result = await env.DB.prepare(`
      INSERT INTO project_media (
        project_id, type, url, thumbnail_url, title, caption, sort_order
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      projectId,
      media.type,
      media.url,
      media.thumbnail_url,
      media.title,
      media.caption,
      media.sort_order
    ).run();

    await touchProject(env, projectId);
    const created = await getProjectMediaById(env, projectId, result.meta.last_row_id);
    return json({ ok: true, media: created }, 201);
  }

  if (reorderMatch && request.method === "PATCH") {
    const body = await request.json();
    const mediaIds = body.media_ids;

    if (!Array.isArray(mediaIds)) {
      return json({ ok: false, error: "media_ids must be an array" }, 400);
    }

    const ids = mediaIds.map(toId);
    if (ids.some((id) => id === null) || new Set(ids).size !== ids.length) {
      return json({ ok: false, error: "media_ids must contain unique positive integers" }, 400);
    }

    const current = await getProjectMedia(env, projectId);
    const currentIds = current.results.map((item) => item.id).sort((a, b) => a - b);
    const requestedIds = [...ids].sort((a, b) => a - b);
    const containsAllMedia = currentIds.length === requestedIds.length
      && currentIds.every((id, index) => id === requestedIds[index]);

    if (!containsAllMedia) {
      return json({
        ok: false,
        error: "media_ids must contain every media id for this project exactly once",
      }, 400);
    }

    if (ids.length > 0) {
      await env.DB.batch(ids.map((id, sortOrder) => env.DB.prepare(`
        UPDATE project_media
        SET sort_order = ?
        WHERE id = ? AND project_id = ?
      `).bind(sortOrder, id, projectId)));
      await touchProject(env, projectId);
    }

    const reordered = await getProjectMedia(env, projectId);
    return json({ ok: true, media: reordered.results });
  }

  if (itemMatch) {
    const mediaId = toId(itemMatch[2]);
    if (!mediaId) {
      return json({ ok: false, error: "Invalid media id" }, 400);
    }

    const current = await getProjectMediaById(env, projectId, mediaId);
    if (!current) {
      return json({ ok: false, error: "Media not found" }, 404);
    }

    if (request.method === "PATCH") {
      const body = await request.json();
      const validated = validateMedia(body, current);
      if (validated.error) {
        return json({ ok: false, error: validated.error }, 400);
      }

      const media = validated.media;
      await env.DB.prepare(`
        UPDATE project_media
        SET type = ?, url = ?, thumbnail_url = ?, title = ?, caption = ?, sort_order = ?
        WHERE id = ? AND project_id = ?
      `).bind(
        media.type,
        media.url,
        media.thumbnail_url,
        media.title,
        media.caption,
        media.sort_order,
        mediaId,
        projectId
      ).run();

      await touchProject(env, projectId);
      const updated = await getProjectMediaById(env, projectId, mediaId);
      return json({ ok: true, media: updated });
    }

    if (request.method === "DELETE") {
      await env.DB.prepare(`
        DELETE FROM project_media WHERE id = ? AND project_id = ?
      `).bind(mediaId, projectId).run();
      await touchProject(env, projectId);
      return json({ ok: true, id: mediaId, deleted: true });
    }
  }

  return json({ ok: false, error: "Method not allowed" }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({
          ok: true,
          name: "kanecat-api",
          time: new Date().toISOString(),
        });
      }

      if (request.method === "GET" && url.pathname === "/projects") {
        const result = await env.DB.prepare(`
          SELECT *
          FROM projects
          WHERE status != 'deleted'
          ORDER BY featured DESC, sort_order ASC, updated_at DESC
          LIMIT 100
        `).all();

        return json({
          ok: true,
          projects: result.results.map(formatProject),
          server_time: new Date().toISOString(),
        });
      }

      if (request.method === "GET" && url.pathname.startsWith("/projects/")) {
        const slug = decodeURIComponent(url.pathname.split("/")[2] || "");

        const project = await env.DB.prepare(`
          SELECT *
          FROM projects
          WHERE slug = ? AND status != 'deleted'
          LIMIT 1
        `).bind(slug).first();

        if (!project) {
          return json({ ok: false, error: "Project not found" }, 404);
        }

        const [media, news] = await Promise.all([
          getProjectMedia(env, project.id),
          env.DB.prepare(`
            SELECT *
            FROM news
            WHERE project_id = ? AND status = 'published'
            ORDER BY featured DESC, published_at DESC
            LIMIT 20
          `).bind(project.id).all(),
        ]);

        return json({
          ok: true,
          project: formatProject(project),
          media: media.results,
          news: news.results,
        });
      }

      if (request.method === "GET" && url.pathname === "/news") {
        const projectSlug = url.searchParams.get("project");
        const since = url.searchParams.get("since");

        let query = `
          SELECT
            news.*,
            projects.slug AS project_slug,
            projects.title AS project_title
          FROM news
          LEFT JOIN projects ON projects.id = news.project_id
          WHERE news.status = 'published'
        `;

        const params = [];

        if (projectSlug) {
          query += " AND projects.slug = ?";
          params.push(projectSlug);
        }

        if (since) {
          query += " AND news.updated_at > ?";
          params.push(since);
        }

        query += " ORDER BY news.featured DESC, news.published_at DESC LIMIT 100";

        const result = await env.DB.prepare(query).bind(...params).all();

        return json({
          ok: true,
          news: result.results,
          server_time: new Date().toISOString(),
        });
      }

      if (request.method === "GET" && url.pathname.startsWith("/news/")) {
        const slug = decodeURIComponent(url.pathname.split("/")[2] || "");

        const item = await env.DB.prepare(`
          SELECT
            news.*,
            projects.slug AS project_slug,
            projects.title AS project_title
          FROM news
          LEFT JOIN projects ON projects.id = news.project_id
          WHERE news.slug = ? AND news.status = 'published'
          LIMIT 1
        `).bind(slug).first();

        if (!item) {
          return json({ ok: false, error: "News not found" }, 404);
        }

        return json({ ok: true, news: item });
      }

      if (request.method === "GET" && url.pathname === "/feed") {
        const projects = await env.DB.prepare(`
          SELECT *
          FROM projects
          WHERE status != 'deleted'
          ORDER BY featured DESC, sort_order ASC, updated_at DESC
          LIMIT 6
        `).all();

        const news = await env.DB.prepare(`
          SELECT
            news.*,
            projects.slug AS project_slug,
            projects.title AS project_title
          FROM news
          LEFT JOIN projects ON projects.id = news.project_id
          WHERE news.status = 'published'
          ORDER BY news.featured DESC, news.published_at DESC
          LIMIT 10
        `).all();

        return json({
          ok: true,
          projects: projects.results.map(formatProject),
          news: news.results,
          server_time: new Date().toISOString(),
        });
      }

      const mediaResponse = await handleProjectMediaRequest(request, env, url.pathname);
      if (mediaResponse) return mediaResponse;

      // Admin: list projects, including drafts/paused. Deleted hidden by default.
      if (request.method === "GET" && url.pathname === "/admin/projects") {
        if (!requireAdmin(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const includeDeleted = url.searchParams.get("include_deleted") === "1";
        const query = includeDeleted
          ? `
            SELECT *
            FROM projects
            ORDER BY featured DESC, sort_order ASC, updated_at DESC
            LIMIT 200
          `
          : `
            SELECT *
            FROM projects
            WHERE status != 'deleted'
            ORDER BY featured DESC, sort_order ASC, updated_at DESC
            LIMIT 200
          `;

        const result = await env.DB.prepare(query).all();

        return json({
          ok: true,
          projects: result.results.map(formatProject),
          server_time: new Date().toISOString(),
        });
      }

      if (request.method === "GET" && /^\/admin\/projects\/\d+\/?$/.test(url.pathname)) {
        if (!requireAdmin(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const id = Number(url.pathname.split("/")[3]);
        const project = await getProjectById(env, id);

        if (!project) {
          return json({ ok: false, error: "Project not found" }, 404);
        }

        return json({ ok: true, project: formatProject(project) });
      }

      if (request.method === "POST" && url.pathname === "/admin/projects") {
        if (!requireAdmin(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const body = await request.json();

        const title = body.title?.trim();
        const slug = body.slug?.trim() || slugify(title);
        const summary = body.summary?.trim() || "";
        const description = body.description?.trim() || "";
        const longDescription = body.long_description?.trim() || "";
        const imageUrl = body.image_url?.trim() || "";
        const bannerUrl = body.banner_url?.trim() || "";
        const websiteUrl = body.website_url?.trim() || "";
        const repoUrl = body.repo_url?.trim() || "";
        const downloadUrl = body.download_url?.trim() || "";
        const technologies = serializeTechnologies(body.technologies);
        const status = body.status || "development";
        const featured = body.featured ? 1 : 0;
        const sortOrder = toInteger(body.sort_order, 0);

        if (!title || !slug || !summary) {
          return json({ ok: false, error: "title, slug and summary are required" }, 400);
        }
        if (technologies === null) {
          return json({ ok: false, error: "technologies must be an array of strings" }, 400);
        }
        if (sortOrder === null) {
          return json({ ok: false, error: "sort_order must be an integer" }, 400);
        }

        const result = await env.DB.prepare(`
          INSERT INTO projects (
            slug, title, summary, description, long_description, image_url,
            banner_url, website_url, repo_url, download_url, technologies,
            status, featured, sort_order,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(
          slug,
          title,
          summary,
          description,
          longDescription,
          imageUrl,
          bannerUrl,
          websiteUrl,
          repoUrl,
          downloadUrl,
          technologies,
          status,
          featured,
          sortOrder
        ).run();

        return json({
          ok: true,
          id: result.meta.last_row_id,
          slug,
        }, 201);
      }

      if (request.method === "PATCH" && /^\/admin\/projects\/\d+\/?$/.test(url.pathname)) {
        if (!requireAdmin(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const id = Number(url.pathname.split("/")[3]);
        const current = await getProjectById(env, id);

        if (!current) {
          return json({ ok: false, error: "Project not found" }, 404);
        }

        const body = await request.json();
        const technologies = body.technologies === undefined
          ? serializeTechnologies(current.technologies)
          : serializeTechnologies(body.technologies);

        const updated = {
          slug: String(valueOrCurrent(body, "slug", current) || "").trim(),
          title: String(valueOrCurrent(body, "title", current) || "").trim(),
          summary: String(valueOrCurrent(body, "summary", current) || "").trim(),
          description: String(valueOrCurrent(body, "description", current) || ""),
          long_description: String(valueOrCurrent(body, "long_description", current) || ""),
          image_url: String(valueOrCurrent(body, "image_url", current) || ""),
          banner_url: String(valueOrCurrent(body, "banner_url", current) || ""),
          website_url: String(valueOrCurrent(body, "website_url", current) || ""),
          repo_url: String(valueOrCurrent(body, "repo_url", current) || ""),
          download_url: String(valueOrCurrent(body, "download_url", current) || ""),
          technologies,
          status: String(valueOrCurrent(body, "status", current) || "development"),
          featured: toFeatured(body.featured, current.featured),
          sort_order: toInteger(body.sort_order, current.sort_order),
        };

        if (!updated.title || !updated.slug || !updated.summary) {
          return json({ ok: false, error: "title, slug and summary are required" }, 400);
        }
        if (updated.technologies === null) {
          return json({ ok: false, error: "technologies must be an array of strings" }, 400);
        }
        if (updated.sort_order === null) {
          return json({ ok: false, error: "sort_order must be an integer" }, 400);
        }

        await env.DB.prepare(`
          UPDATE projects
          SET
            slug = ?,
            title = ?,
            summary = ?,
            description = ?,
            long_description = ?,
            image_url = ?,
            banner_url = ?,
            website_url = ?,
            repo_url = ?,
            download_url = ?,
            technologies = ?,
            status = ?,
            featured = ?,
            sort_order = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          updated.slug,
          updated.title,
          updated.summary,
          updated.description,
          updated.long_description,
          updated.image_url,
          updated.banner_url,
          updated.website_url,
          updated.repo_url,
          updated.download_url,
          updated.technologies,
          updated.status,
          updated.featured,
          updated.sort_order,
          id
        ).run();

        return json({ ok: true, id, slug: updated.slug });
      }

      if (request.method === "DELETE" && /^\/admin\/projects\/\d+\/?$/.test(url.pathname)) {
        if (!requireAdmin(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const id = Number(url.pathname.split("/")[3]);
        const current = await getProjectById(env, id);

        if (!current) {
          return json({ ok: false, error: "Project not found" }, 404);
        }

        await env.DB.prepare(`
          UPDATE projects
          SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(id).run();

        return json({ ok: true, id, deleted: true });
      }

      // Admin: list news, including drafts. Deleted hidden by default.
      if (request.method === "GET" && url.pathname === "/admin/news") {
        if (!requireAdmin(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const includeDeleted = url.searchParams.get("include_deleted") === "1";
        const query = `
          SELECT
            news.*,
            projects.slug AS project_slug,
            projects.title AS project_title
          FROM news
          LEFT JOIN projects ON projects.id = news.project_id
          ${includeDeleted ? "" : "WHERE news.status != 'deleted'"}
          ORDER BY news.featured DESC, news.published_at DESC, news.updated_at DESC
          LIMIT 200
        `;

        const result = await env.DB.prepare(query).all();

        return json({
          ok: true,
          news: result.results,
          server_time: new Date().toISOString(),
        });
      }

      if (request.method === "GET" && /^\/admin\/news\/\d+\/?$/.test(url.pathname)) {
        if (!requireAdmin(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const id = Number(url.pathname.split("/")[3]);
        const item = await getNewsById(env, id);

        if (!item) {
          return json({ ok: false, error: "News not found" }, 404);
        }

        return json({ ok: true, news: item });
      }

      if (request.method === "POST" && url.pathname === "/admin/news") {
        if (!requireAdmin(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const body = await request.json();

        const title = body.title?.trim();
        const slug = body.slug?.trim() || slugify(title);
        const summary = body.summary?.trim() || "";
        const content = body.content?.trim() || "";
        const imageUrl = body.image_url?.trim() || "";
        const linkUrl = body.link_url?.trim() || "";
        const status = body.status || "published";
        const featured = body.featured ? 1 : 0;

        let projectId = body.project_id ?? null;

        if (!projectId && body.project_slug) {
          projectId = await getProjectIdBySlug(env, body.project_slug);
        }

        if (!title || !slug || !summary) {
          return json({ ok: false, error: "title, slug and summary are required" }, 400);
        }

        const result = await env.DB.prepare(`
          INSERT INTO news (
            project_id, slug, title, summary, content,
            image_url, link_url, status, featured,
            updated_at, published_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).bind(
          projectId,
          slug,
          title,
          summary,
          content,
          imageUrl,
          linkUrl,
          status,
          featured
        ).run();

        return json({
          ok: true,
          id: result.meta.last_row_id,
          slug,
        }, 201);
      }

      if (request.method === "PATCH" && /^\/admin\/news\/\d+\/?$/.test(url.pathname)) {
        if (!requireAdmin(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const id = Number(url.pathname.split("/")[3]);
        const current = await getNewsById(env, id);

        if (!current) {
          return json({ ok: false, error: "News not found" }, 404);
        }

        const body = await request.json();

        let projectId = current.project_id;

        if (body.project_id !== undefined) {
          projectId = body.project_id || null;
        }

        if (body.project_slug !== undefined) {
          projectId = body.project_slug ? await getProjectIdBySlug(env, body.project_slug) : null;
        }

        const updated = {
          project_id: projectId,
          slug: String(valueOrCurrent(body, "slug", current) || "").trim(),
          title: String(valueOrCurrent(body, "title", current) || "").trim(),
          summary: String(valueOrCurrent(body, "summary", current) || "").trim(),
          content: String(valueOrCurrent(body, "content", current) || ""),
          image_url: String(valueOrCurrent(body, "image_url", current) || ""),
          link_url: String(valueOrCurrent(body, "link_url", current) || ""),
          status: String(valueOrCurrent(body, "status", current) || "published"),
          featured: toFeatured(body.featured, current.featured),
          published_at: String(valueOrCurrent(body, "published_at", current) || ""),
        };

        if (!updated.title || !updated.slug || !updated.summary) {
          return json({ ok: false, error: "title, slug and summary are required" }, 400);
        }

        await env.DB.prepare(`
          UPDATE news
          SET
            project_id = ?,
            slug = ?,
            title = ?,
            summary = ?,
            content = ?,
            image_url = ?,
            link_url = ?,
            status = ?,
            featured = ?,
            published_at = COALESCE(NULLIF(?, ''), published_at),
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          updated.project_id,
          updated.slug,
          updated.title,
          updated.summary,
          updated.content,
          updated.image_url,
          updated.link_url,
          updated.status,
          updated.featured,
          updated.published_at,
          id
        ).run();

        return json({ ok: true, id, slug: updated.slug });
      }

      if (request.method === "DELETE" && /^\/admin\/news\/\d+\/?$/.test(url.pathname)) {
        if (!requireAdmin(request, env)) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }

        const id = Number(url.pathname.split("/")[3]);
        const current = await getNewsById(env, id);

        if (!current) {
          return json({ ok: false, error: "News not found" }, 404);
        }

        await env.DB.prepare(`
          UPDATE news
          SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(id).run();

        return json({ ok: true, id, deleted: true });
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (error) {
      return json({
        ok: false,
        error: error.message || "Internal error",
      }, 500);
    }
  },
};
