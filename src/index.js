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
  return auth === `Bearer ${env.ADMIN_TOKEN}`;
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
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
          projects: result.results,
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

        const news = await env.DB.prepare(`
          SELECT *
          FROM news
          WHERE project_id = ? AND status = 'published'
          ORDER BY featured DESC, published_at DESC
          LIMIT 20
        `).bind(project.id).all();

        return json({
          ok: true,
          project,
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
          projects: projects.results,
          news: news.results,
          server_time: new Date().toISOString(),
        });
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
        const imageUrl = body.image_url?.trim() || "";
        const websiteUrl = body.website_url?.trim() || "";
        const repoUrl = body.repo_url?.trim() || "";
        const status = body.status || "development";
        const featured = body.featured ? 1 : 0;
        const sortOrder = Number(body.sort_order || 0);

        if (!title || !slug || !summary) {
          return json({ ok: false, error: "title, slug and summary are required" }, 400);
        }

        const result = await env.DB.prepare(`
          INSERT INTO projects (
            slug, title, summary, description, image_url,
            website_url, repo_url, status, featured, sort_order,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(
          slug,
          title,
          summary,
          description,
          imageUrl,
          websiteUrl,
          repoUrl,
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

      return json({ ok: false, error: "Not found" }, 404);
    } catch (error) {
      return json({
        ok: false,
        error: error.message || "Internal error",
      }, 500);
    }
  },
};