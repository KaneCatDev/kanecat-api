import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const adminHeaders = {
	Authorization: "Bearer test-admin-token",
	"Content-Type": "application/json",
};

async function request(path, options = {}) {
	const response = await SELF.fetch(`http://example.com${path}`, options);
	return { response, body: await response.json() };
}

describe("KaneCat API", () => {
	beforeAll(async () => {
		await env.DB.batch([
			env.DB.prepare(`
				INSERT INTO projects (slug, title, summary, description, status, featured)
				VALUES ('gakeyru', 'Gakeyru', 'Game project', 'Legacy description', 'published', 1)
			`),
			env.DB.prepare(`
				INSERT INTO projects (slug, title, summary, status)
				VALUES ('hana-ai-vrc', 'Hana AI VRC', 'AI project', 'development')
			`),
		]);

		const project = await env.DB.prepare(
			"SELECT id FROM projects WHERE slug = 'gakeyru'"
		).first();
		await env.DB.prepare(`
			INSERT INTO news (project_id, slug, title, summary, content, status)
			VALUES (?, 'gakeyru-launch', 'Launch', 'Launch news', 'News content', 'published')
		`).bind(project.id).run();
	});

	it("keeps the existing public endpoints working", async () => {
		const health = await request("/health");
		expect(health.response.status).toBe(200);
		expect(health.body.ok).toBe(true);

		const projects = await request("/projects");
		expect(projects.response.status).toBe(200);
		expect(projects.body.projects.map((item) => item.slug)).toEqual(
			expect.arrayContaining(["gakeyru", "hana-ai-vrc"])
		);

		const project = await request("/projects/gakeyru");
		expect(project.response.status).toBe(200);
		expect(project.body.project.description).toBe("Legacy description");
		expect(project.body.media).toEqual([]);
		expect(project.body.news[0].slug).toBe("gakeyru-launch");

		const news = await request("/news?project=gakeyru");
		expect(news.response.status).toBe(200);
		expect(news.body.news[0].project_slug).toBe("gakeyru");

		const newsItem = await request("/news/gakeyru-launch");
		expect(newsItem.response.status).toBe(200);
		expect(newsItem.body.news.title).toBe("Launch");

		const feed = await request("/feed");
		expect(feed.response.status).toBe(200);
		expect(feed.body.projects.length).toBeGreaterThan(0);
		expect(feed.body.news.length).toBeGreaterThan(0);
	});

	it("keeps the project and news admin CRUD routes working", async () => {
		const adminProjects = await request("/admin/projects", { headers: adminHeaders });
		expect(adminProjects.response.status).toBe(200);
		const legacyProject = adminProjects.body.projects.find((item) => item.slug === "gakeyru");
		expect((await request(`/admin/projects/${legacyProject.id}`, {
			method: "PATCH",
			headers: adminHeaders,
			body: JSON.stringify({ summary: "Game project" }),
		})).response.status).toBe(200);

		const createdProject = await request("/admin/projects", {
			method: "POST",
			headers: adminHeaders,
			body: JSON.stringify({
				title: "New Project",
				summary: "Summary",
				banner_url: "https://media.kanecat.dev/banner.webp",
				download_url: "https://media.kanecat.dev/game.zip",
				long_description: "Long description",
				technologies: ["JavaScript", "Cloudflare Workers"],
			}),
		});
		expect(createdProject.response.status).toBe(201);

		const projectId = createdProject.body.id;
		const project = await request(`/admin/projects/${projectId}`, { headers: adminHeaders });
		expect(project.body.project.technologies).toEqual(["JavaScript", "Cloudflare Workers"]);

		const patchedProject = await request(`/admin/projects/${projectId}`, {
			method: "PATCH",
			headers: adminHeaders,
			body: JSON.stringify({ summary: "Updated summary" }),
		});
		expect(patchedProject.response.status).toBe(200);

		const createdNews = await request("/admin/news", {
			method: "POST",
			headers: adminHeaders,
			body: JSON.stringify({
				project_id: projectId,
				title: "New update",
				summary: "Update summary",
			}),
		});
		expect(createdNews.response.status).toBe(201);

		const newsId = createdNews.body.id;
		expect((await request("/admin/news", { headers: adminHeaders })).response.status).toBe(200);
		expect((await request(`/admin/news/${newsId}`, { headers: adminHeaders })).response.status).toBe(200);
		expect((await request(`/admin/news/${newsId}`, {
			method: "PATCH",
			headers: adminHeaders,
			body: JSON.stringify({ content: "Updated content" }),
		})).response.status).toBe(200);
		expect((await request(`/admin/news/${newsId}`, {
			method: "DELETE",
			headers: adminHeaders,
		})).response.status).toBe(200);

		expect((await request(`/admin/projects/${projectId}`, {
			method: "DELETE",
			headers: adminHeaders,
		})).response.status).toBe(200);
	});

	it("protects and manages ordered project media", async () => {
		const project = await env.DB.prepare(
			"SELECT id FROM projects WHERE slug = 'gakeyru'"
		).first();
		const basePath = `/admin/projects/${project.id}/media`;

		expect((await request(basePath)).response.status).toBe(401);

		const image = await request(basePath, {
			method: "POST",
			headers: adminHeaders,
			body: JSON.stringify({
				type: "image",
				url: "https://media.kanecat.dev/gakeyru/screenshot.webp",
				title: "Screenshot",
			}),
		});
		expect(image.response.status).toBe(201);

		const video = await request(basePath, {
			method: "POST",
			headers: adminHeaders,
			body: JSON.stringify({
				type: "youtube",
				url: "https://www.youtube.com/watch?v=example",
				thumbnail_url: "https://media.kanecat.dev/gakeyru/video.webp",
			}),
		});
		expect(video.response.status).toBe(201);

		const patched = await request(`${basePath}/${image.body.media.id}`, {
			method: "PATCH",
			headers: adminHeaders,
			body: JSON.stringify({ caption: "Updated caption" }),
		});
		expect(patched.body.media.caption).toBe("Updated caption");

		const reordered = await request(`${basePath}/reorder`, {
			method: "PATCH",
			headers: adminHeaders,
			body: JSON.stringify({ media_ids: [video.body.media.id, image.body.media.id] }),
		});
		expect(reordered.response.status).toBe(200);
		expect(reordered.body.media.map((item) => item.id)).toEqual([
			video.body.media.id,
			image.body.media.id,
		]);

		const publicProject = await request("/projects/gakeyru");
		expect(publicProject.body.media.map((item) => item.id)).toEqual([
			video.body.media.id,
			image.body.media.id,
		]);

		const deleted = await request(`${basePath}/${image.body.media.id}`, {
			method: "DELETE",
			headers: adminHeaders,
		});
		expect(deleted.response.status).toBe(200);
		expect((await request(basePath, { headers: adminHeaders })).body.media).toHaveLength(1);
	});
});
