import {
	defineWorkersConfig,
	readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
	const migrations = await readD1Migrations("./migrations");

	return {
		test: {
			setupFiles: ["./test/apply-migrations.js"],
			poolOptions: {
				workers: {
					wrangler: { configPath: "./wrangler.jsonc" },
					miniflare: {
						bindings: {
							ADMIN_TOKEN: "test-admin-token",
							TEST_MIGRATIONS: migrations,
						},
					},
				},
			},
		},
	};
});
