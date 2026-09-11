export default {

  async fetch(request, env) {

    const requestOrigin = request.headers.get("Origin") || "";
    const allowedOrigins = String(
      env.CODEPILOT_ALLOWED_ORIGINS ||
      "https://kerberosum.github.io,https://kersumcodingbot.netlify.app"
    ).split(",").map(x => x.trim()).filter(Boolean);
    const corsOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : "";

    const corsHeaders = {
      ...(corsOrigin ? {
        "Access-Control-Allow-Origin": corsOrigin,
        "Vary": "Origin"
      } : {}),
      "Access-Control-Allow-Methods":
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400"
    };


    function json(data, status = 200) {

      return new Response(
        JSON.stringify(data),
        {
          status,
          headers: {
            ...corsHeaders,
            "Content-Type":
              "application/json"
          }
        }
      );

    }


    if (request.method === "OPTIONS") {
      if (requestOrigin && !corsOrigin) {
        return new Response("Origin not allowed", { status: 403 });
      }
      return new Response(
        null,
        {
          status: 204,
          headers: corsHeaders
        }
      );
    }


    try {

      if (!env.DB) {

        return json(
          {
            success: false,
            error: "D1 binding DB is missing."
          },
          500
        );

      }


      const url =
        new URL(request.url);


      const path =
        url.pathname.replace(/\/+$/, "") || "/";


      /* =====================================================
         AUTHENTICATION
         Single-user login. Password + signing secret live only
         in Cloudflare Worker secrets, never in GitHub.
      ===================================================== */

      const textEncoder = new TextEncoder();

      function bytesToBase64Url(bytes) {
        let s = "";
        for (const b of bytes) s += String.fromCharCode(b);
        return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      }

      function base64UrlToBytes(value) {
        const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
        const raw = atob(padded);
        return Uint8Array.from(raw, ch => ch.charCodeAt(0));
      }

      async function sha256(value) {
        return new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(String(value))));
      }

      function constantTimeEqual(a, b) {
        if (a.length !== b.length) return false;
        let diff = 0;
        for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        return diff === 0;
      }

      async function signSession(payload) {
        const key = await crypto.subtle.importKey(
          "raw",
          textEncoder.encode(String(env.CODEPILOT_SESSION_SECRET || "")),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );
        return new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload)));
      }

      async function issueSessionToken() {
        const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
        const nonce = crypto.randomUUID();
        const payload = `${expiresAt}.${nonce}`;
        const signature = await signSession(payload);
        return { token: `${payload}.${bytesToBase64Url(signature)}`, expiresAt };
      }

      async function verifySessionToken(token) {
        try {
          if (!env.CODEPILOT_SESSION_SECRET) return false;
          const parts = String(token || "").split(".");
          if (parts.length !== 3) return false;
          const [expiresText, nonce, signatureText] = parts;
          const expiresAt = Number(expiresText);
          if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || !nonce) return false;
          const expected = await signSession(`${expiresText}.${nonce}`);
          const actual = base64UrlToBytes(signatureText);
          return constantTimeEqual(expected, actual);
        } catch {
          return false;
        }
      }

      async function requestIsAuthenticated() {
        const header = request.headers.get("Authorization") || "";
        const match = header.match(/^Bearer\s+(.+)$/i);
        return Boolean(match && await verifySessionToken(match[1]));
      }

      if (path === "/auth/login" && request.method === "POST") {
        if (!env.CODEPILOT_PASSWORD || !env.CODEPILOT_SESSION_SECRET) {
          return json({ success: false, error: "CodePilot authentication secrets are not configured." }, 500);
        }
        const body = await safeJSON(request);
        const supplied = await sha256(String(body?.password || ""));
        const expected = await sha256(String(env.CODEPILOT_PASSWORD));
        if (!constantTimeEqual(supplied, expected)) {
          await new Promise(resolve => setTimeout(resolve, 250));
          return json({ success: false, error: "Incorrect password." }, 401);
        }
        const session = await issueSessionToken();
        return json({ success: true, ...session });
      }

      if (path === "/auth/check" && request.method === "GET") {
        const ok = await requestIsAuthenticated();
        return json({ success: ok }, ok ? 200 : 401);
      }

      const publicRoute = (path === "/" || path === "/health");
      if (!publicRoute && !(await requestIsAuthenticated())) {
        return json({ success: false, error: "Authentication required." }, 401);
      }


      /* =====================================================
         HEALTH
      ===================================================== */

      if (
        path === "/" ||
        path === "/health"
      ) {

        return json({
          success: true,
          service: "CodePilot API",
          version: 2,
          database: true
        });

      }


      /* =====================================================
         OPENROUTER FREE MODELS
         GET /models
      ===================================================== */

      if (
        path === "/models" &&
        request.method === "GET"
      ) {

        if (!env.OPENROUTER_API_KEY) {
          return json(
            {
              success: false,
              error: "OPENROUTER_API_KEY is missing."
            },
            500
          );
        }

        const modelResponse =
          await fetch(
            "https://openrouter.ai/api/v1/models?output_modalities=text",
            {
              headers: {
                "Authorization":
                  "Bearer " +
                  env.OPENROUTER_API_KEY,
                "X-OpenRouter-Title":
                  "CodePilot"
              }
            }
          );

        const modelText =
          await modelResponse.text();

        if (!modelResponse.ok) {
          return json(
            {
              success: false,
              error:
                "OpenRouter models HTTP " +
                modelResponse.status,
              details:
                modelText
            },
            modelResponse.status
          );
        }

        let modelData;

        try {
          modelData =
            JSON.parse(modelText);
        }
        catch {
          return json(
            {
              success: false,
              error:
                "OpenRouter models returned invalid JSON."
            },
            502
          );
        }

        const freeModels =
          (Array.isArray(modelData?.data)
            ? modelData.data
            : [])
          .filter(
            model =>
              typeof model?.id === "string" &&
              model.id.endsWith(":free")
          )
          .map(
            model => ({
              id: model.id,
              name:
                String(
                  model.name ||
                  model.id
                ),
              contextLength:
                Number(
                  model.context_length ||
                  0
                ),
              description:
                String(
                  model.description ||
                  ""
                )
            })
          )
          .sort(
            (a, b) =>
              a.name.localeCompare(
                b.name
              )
          );

        return json({
          success: true,
          refreshedAt:
            Date.now(),
          models: [
            {
              id:
                "openrouter/free",
              name:
                "Free Auto Router",
              contextLength:
                200000,
              description:
                "OpenRouter automatically chooses an available free model."
            },
            ...freeModels
          ]
        });

      }


      /* =====================================================
         D1 STORAGE INSPECTION
         GET /storage
         Authenticated. Reports a conservative CodePilot app
         data estimate and item sizes for cleanup. It does not
         call the Cloudflare account Analytics API.
      ===================================================== */

      if (
        path === "/storage" &&
        request.method === "GET"
      ) {

        const limitBytes = 500 * 1024 * 1024;
        const detailed = url.searchParams.get("detail") === "1";

        const summaryStatement = env.DB.prepare(`
          SELECT
            (SELECT COUNT(*) FROM projects) AS project_count,
            (SELECT COUNT(*) FROM project_files) AS file_count,
            (SELECT COUNT(*) FROM chats) AS chat_count,
            (SELECT COUNT(*) FROM messages) AS message_count,
            COALESCE((SELECT SUM(
              LENGTH(CAST(id AS BLOB)) +
              LENGTH(CAST(name AS BLOB)) +
              LENGTH(CAST(description AS BLOB))
            ) FROM projects), 0) +
            COALESCE((SELECT SUM(
              LENGTH(CAST(id AS BLOB)) +
              LENGTH(CAST(project_id AS BLOB)) +
              LENGTH(CAST(name AS BLOB)) +
              LENGTH(CAST(content AS BLOB)) +
              LENGTH(CAST(language AS BLOB))
            ) FROM project_files), 0) +
            COALESCE((SELECT SUM(
              LENGTH(CAST(id AS BLOB)) +
              LENGTH(CAST(title AS BLOB))
            ) FROM chats), 0) +
            COALESCE((SELECT SUM(
              LENGTH(CAST(id AS BLOB)) +
              LENGTH(CAST(chat_id AS BLOB)) +
              LENGTH(CAST(role AS BLOB)) +
              LENGTH(CAST(content AS BLOB))
            ) FROM messages), 0) +
            COALESCE((SELECT SUM(
              LENGTH(CAST(chat_id AS BLOB)) +
              LENGTH(CAST(project_id AS BLOB))
            ) FROM chat_projects), 0) AS content_bytes
        `);

        const makeBase = (summaryResult, inspectionRowsRead = 0) => {
          const summary = summaryResult?.results?.[0] || {};
          const counts = {
            projects: Number(summary.project_count || 0),
            files: Number(summary.file_count || 0),
            chats: Number(summary.chat_count || 0),
            messages: Number(summary.message_count || 0)
          };
          const contentBytes = Number(summary.content_bytes || 0);
          const rowCount = counts.projects + counts.files + counts.chats + counts.messages;
          const estimatedBytes = Math.min(
            limitBytes,
            contentBytes + (rowCount * 256) + 12288
          );
          return {
            success: true,
            limitBytes,
            contentBytes,
            estimatedBytes,
            remainingBytes: Math.max(0, limitBytes - estimatedBytes),
            counts,
            inspectionRowsRead,
            note: "Estimated app footprint only; use Cloudflare Analytics databaseSizeBytes for authoritative physical database size."
          };
        };

        if (!detailed) {
          const summaryResult = await summaryStatement.all();
          return json(makeBase(summaryResult, Number(summaryResult?.meta?.rows_read || 0)));
        }

        const results = await env.DB.batch([
          summaryStatement,

          env.DB.prepare(`
            WITH file_usage AS (
              SELECT
                project_id,
                COUNT(*) AS file_count,
                COALESCE(SUM(
                  LENGTH(CAST(name AS BLOB)) +
                  LENGTH(CAST(content AS BLOB)) +
                  LENGTH(CAST(language AS BLOB))
                ), 0) AS file_bytes
              FROM project_files
              GROUP BY project_id
            ),
            chat_usage AS (
              SELECT
                cp.project_id,
                COUNT(DISTINCT c.id) AS chat_count,
                COALESCE(SUM(LENGTH(CAST(m.content AS BLOB))), 0) AS chat_bytes
              FROM chat_projects cp
              JOIN chats c ON c.id = cp.chat_id
              LEFT JOIN messages m ON m.chat_id = c.id
              GROUP BY cp.project_id
            )
            SELECT
              p.id,
              p.name,
              COALESCE(f.file_count, 0) AS file_count,
              COALESCE(c.chat_count, 0) AS chat_count,
              COALESCE(f.file_bytes, 0) + COALESCE(c.chat_bytes, 0) AS bytes
            FROM projects p
            LEFT JOIN file_usage f ON f.project_id = p.id
            LEFT JOIN chat_usage c ON c.project_id = p.id
            ORDER BY bytes DESC, p.updated_at DESC
            LIMIT 50
          `),

          env.DB.prepare(`
            WITH message_usage AS (
              SELECT
                chat_id,
                COUNT(*) AS message_count,
                COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS message_bytes
              FROM messages
              GROUP BY chat_id
            )
            SELECT
              c.id,
              c.title,
              cp.project_id,
              p.name AS project_name,
              COALESCE(m.message_count, 0) AS message_count,
              COALESCE(m.message_bytes, 0) + LENGTH(CAST(c.title AS BLOB)) AS bytes
            FROM chats c
            LEFT JOIN message_usage m ON m.chat_id = c.id
            LEFT JOIN chat_projects cp ON cp.chat_id = c.id
            LEFT JOIN projects p ON p.id = cp.project_id
            ORDER BY bytes DESC, c.updated_at DESC
            LIMIT 100
          `),

          env.DB.prepare(`
            SELECT
              f.id,
              f.project_id,
              f.name,
              p.name AS project_name,
              LENGTH(CAST(f.content AS BLOB)) + LENGTH(CAST(f.name AS BLOB)) AS bytes
            FROM project_files f
            LEFT JOIN projects p ON p.id = f.project_id
            ORDER BY bytes DESC
            LIMIT 50
          `)
        ]);

        const inspectionRowsRead = results.reduce(
          (sum, result) => sum + Number(result?.meta?.rows_read || 0),
          0
        );
        const payload = makeBase(results[0], inspectionRowsRead);

        payload.projects = (results?.[1]?.results || []).map(x => ({
          id: x.id,
          name: x.name,
          fileCount: Number(x.file_count || 0),
          chatCount: Number(x.chat_count || 0),
          bytes: Number(x.bytes || 0)
        }));
        payload.chats = (results?.[2]?.results || []).map(x => ({
          id: x.id,
          title: x.title,
          projectId: x.project_id || "",
          projectName: x.project_name || "",
          messageCount: Number(x.message_count || 0),
          bytes: Number(x.bytes || 0)
        }));
        payload.largestFiles = (results?.[3]?.results || []).map(x => ({
          id: x.id,
          projectId: x.project_id,
          name: x.name,
          projectName: x.project_name || "",
          bytes: Number(x.bytes || 0)
        }));

        return json(payload);

      }

      /* =====================================================
         PROJECT LIST
         GET /projects
      ===================================================== */

      if (
        path === "/projects" &&
        request.method === "GET"
      ) {

        const result =
          await env.DB
            .prepare(`
              SELECT
                p.id,
                p.name,
                p.description,
                p.created_at,
                p.updated_at,
                COUNT(f.id) AS file_count
              FROM projects p
              LEFT JOIN project_files f
                ON f.project_id = p.id
              GROUP BY p.id
              ORDER BY p.updated_at DESC
            `)
            .all();


        return json({
          success: true,
          projects:
            result.results || []
        });

      }


      /* =====================================================
         CREATE PROJECT
         POST /projects
      ===================================================== */

      if (
        path === "/projects" &&
        request.method === "POST"
      ) {

        const body =
          await safeJSON(request);


        const id =
          crypto.randomUUID();


        const now =
          Date.now();


        const name =
          cleanProjectName(
            body?.name ||
            "Untitled Project"
          );


        await env.DB
          .prepare(`
            INSERT INTO projects (
              id,
              name,
              description,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?)
          `)
          .bind(
            id,
            name,
            "",
            now,
            now
          )
          .run();


        /*
          Automatically create the
          standard web project files.
        */

        const indexId =
          crypto.randomUUID();

        const styleId =
          crypto.randomUUID();

        const scriptId =
          crypto.randomUUID();


        await env.DB.batch([

          env.DB
            .prepare(`
              INSERT INTO project_files (
                id,
                project_id,
                name,
                content,
                language,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              indexId,
              id,
              "index.html",
              defaultHTML(name),
              "html",
              now,
              now
            ),

          env.DB
            .prepare(`
              INSERT INTO project_files (
                id,
                project_id,
                name,
                content,
                language,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              styleId,
              id,
              "style.css",
              defaultCSS(),
              "css",
              now,
              now
            ),

          env.DB
            .prepare(`
              INSERT INTO project_files (
                id,
                project_id,
                name,
                content,
                language,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              scriptId,
              id,
              "script.js",
              defaultJS(),
              "javascript",
              now,
              now
            )

        ]);


        return json({
          success: true,

          project: {
            id,
            name,
            description: "",
            created_at: now,
            updated_at: now
          }
        });

      }


      /* =====================================================
         SINGLE PROJECT
      ===================================================== */

      const projectMatch =
        path.match(
          /^\/projects\/([^/]+)$/
        );


      if (projectMatch) {

        const projectId =
          decodeURIComponent(
            projectMatch[1]
          );


        /* GET PROJECT */

        if (
          request.method === "GET"
        ) {

          const project =
            await env.DB
              .prepare(`
                SELECT *
                FROM projects
                WHERE id = ?
                LIMIT 1
              `)
              .bind(projectId)
              .first();


          if (!project) {

            return json(
              {
                success: false,
                error:
                  "Project not found."
              },
              404
            );

          }


          const filesResult =
            await env.DB
              .prepare(`
                SELECT
                  id,
                  project_id,
                  name,
                  content,
                  language,
                  created_at,
                  updated_at
                FROM project_files
                WHERE project_id = ?
                ORDER BY name ASC
              `)
              .bind(projectId)
              .all();


          return json({
            success: true,
            project,
            files:
              filesResult.results || []
          });

        }


        /* RENAME PROJECT */

        if (
          request.method === "PATCH"
        ) {

          const body =
            await safeJSON(request);


          const name =
            cleanProjectName(
              body?.name ||
              "Untitled Project"
            );


          await env.DB
            .prepare(`
              UPDATE projects
              SET
                name = ?,
                updated_at = ?
              WHERE id = ?
            `)
            .bind(
              name,
              Date.now(),
              projectId
            )
            .run();


          return json({
            success: true,
            name
          });

        }


        /* DELETE PROJECT */

        if (
          request.method === "DELETE"
        ) {

          await env.DB.batch([

            env.DB
              .prepare(`
                DELETE FROM chat_projects
                WHERE project_id = ?
              `)
              .bind(projectId),

            env.DB
              .prepare(`
                DELETE FROM project_files
                WHERE project_id = ?
              `)
              .bind(projectId),

            env.DB
              .prepare(`
                DELETE FROM projects
                WHERE id = ?
              `)
              .bind(projectId)

          ]);


          return json({
            success: true
          });

        }

      }


      /* =====================================================
         FILE LIST / CREATE
         /projects/:projectId/files
      ===================================================== */

      const filesMatch =
        path.match(
          /^\/projects\/([^/]+)\/files$/
        );


      if (filesMatch) {

        const projectId =
          decodeURIComponent(
            filesMatch[1]
          );


        if (
          request.method === "GET"
        ) {

          const result =
            await env.DB
              .prepare(`
                SELECT *
                FROM project_files
                WHERE project_id = ?
                ORDER BY name ASC
              `)
              .bind(projectId)
              .all();


          return json({
            success: true,
            files:
              result.results || []
          });

        }


        if (
          request.method === "POST"
        ) {

          const body =
            await safeJSON(request);


          const name =
            cleanFileName(
              body?.name
            );


          if (!name) {

            return json(
              {
                success: false,
                error:
                  "Invalid file name."
              },
              400
            );

          }


          const existing =
            await env.DB
              .prepare(`
                SELECT id
                FROM project_files
                WHERE
                  project_id = ?
                  AND name = ?
                LIMIT 1
              `)
              .bind(
                projectId,
                name
              )
              .first();


          if (existing) {

            return json(
              {
                success: false,
                error:
                  "A file with that name already exists."
              },
              409
            );

          }


          const id =
            crypto.randomUUID();


          const now =
            Date.now();


          const language =
            languageFromFilename(
              name
            );


          await env.DB.batch([

            env.DB
              .prepare(`
                INSERT INTO project_files (
                  id,
                  project_id,
                  name,
                  content,
                  language,
                  created_at,
                  updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `)
              .bind(
                id,
                projectId,
                name,
                "",
                language,
                now,
                now
              ),

            env.DB
              .prepare(`
                UPDATE projects
                SET updated_at = ?
                WHERE id = ?
              `)
              .bind(
                now,
                projectId
              )

          ]);


          return json({
            success: true,

            file: {
              id,
              project_id:
                projectId,
              name,
              content: "",
              language,
              created_at: now,
              updated_at: now
            }
          });

        }

      }


      /* =====================================================
         INDIVIDUAL FILE
         /projects/:project/files/:file
      ===================================================== */

      const fileMatch =
        path.match(
          /^\/projects\/([^/]+)\/files\/([^/]+)$/
        );


      if (fileMatch) {

        const projectId =
          decodeURIComponent(
            fileMatch[1]
          );


        const fileId =
          decodeURIComponent(
            fileMatch[2]
          );


        if (
          request.method === "GET"
        ) {

          const file =
            await env.DB
              .prepare(`
                SELECT *
                FROM project_files
                WHERE
                  id = ?
                  AND project_id = ?
                LIMIT 1
              `)
              .bind(
                fileId,
                projectId
              )
              .first();


          if (!file) {

            return json(
              {
                success: false,
                error:
                  "File not found."
              },
              404
            );

          }


          return json({
            success: true,
            file
          });

        }


        /*
          SAVE FILE CONTENT
        */

        if (
          request.method === "PUT"
        ) {

          const body =
            await safeJSON(request);


          const content =
            String(
              body?.content ?? ""
            );


          /*
            Keep prototype payloads
            reasonably controlled.
          */

          if (
            content.length >
            500000
          ) {

            return json(
              {
                success: false,
                error:
                  "File is too large."
              },
              413
            );

          }


          const now =
            Date.now();


          await env.DB.batch([

            env.DB
              .prepare(`
                UPDATE project_files
                SET
                  content = ?,
                  updated_at = ?
                WHERE
                  id = ?
                  AND project_id = ?
              `)
              .bind(
                content,
                now,
                fileId,
                projectId
              ),

            env.DB
              .prepare(`
                UPDATE projects
                SET updated_at = ?
                WHERE id = ?
              `)
              .bind(
                now,
                projectId
              )

          ]);


          return json({
            success: true,
            updated_at: now
          });

        }


        /*
          RENAME FILE
        */

        if (
          request.method === "PATCH"
        ) {

          const body =
            await safeJSON(request);


          const name =
            cleanFileName(
              body?.name
            );


          if (!name) {

            return json(
              {
                success: false,
                error:
                  "Invalid file name."
              },
              400
            );

          }


          const now =
            Date.now();


          try {

            await env.DB.batch([

              env.DB
                .prepare(`
                  UPDATE project_files
                  SET
                    name = ?,
                    language = ?,
                    updated_at = ?
                  WHERE
                    id = ?
                    AND project_id = ?
                `)
                .bind(
                  name,
                  languageFromFilename(
                    name
                  ),
                  now,
                  fileId,
                  projectId
                ),

              env.DB
                .prepare(`
                  UPDATE projects
                  SET updated_at = ?
                  WHERE id = ?
                `)
                .bind(
                  now,
                  projectId
                )

            ]);

          }

          catch {

            return json(
              {
                success: false,
                error:
                  "A file with that name already exists."
              },
              409
            );

          }


          return json({
            success: true,
            name,
            language:
              languageFromFilename(
                name
              )
          });

        }


        /*
          DELETE FILE
        */

        if (
          request.method === "DELETE"
        ) {

          await env.DB
            .prepare(`
              DELETE FROM project_files
              WHERE
                id = ?
                AND project_id = ?
            `)
            .bind(
              fileId,
              projectId
            )
            .run();


          await env.DB
            .prepare(`
              UPDATE projects
              SET updated_at = ?
              WHERE id = ?
            `)
            .bind(
              Date.now(),
              projectId
            )
            .run();


          return json({
            success: true
          });

        }

      }


      /* =====================================================
         LINK CHAT TO PROJECT

         POST /projects/:id/link-chat
      ===================================================== */

      const linkMatch =
        path.match(
          /^\/projects\/([^/]+)\/link-chat$/
        );


      if (
        linkMatch &&
        request.method === "POST"
      ) {

        const projectId =
          decodeURIComponent(
            linkMatch[1]
          );


        const body =
          await safeJSON(request);


        const chatId =
          String(
            body?.chatId || ""
          ).trim();


        if (!chatId) {

          return json(
            {
              success: false,
              error:
                "chatId is required."
            },
            400
          );

        }


        /*
          One chat can belong to
          one current project.
        */

        await env.DB
          .prepare(`
            INSERT INTO chat_projects (
              chat_id,
              project_id
            )
            VALUES (?, ?)

            ON CONFLICT(chat_id)
            DO UPDATE SET
              project_id =
                excluded.project_id
          `)
          .bind(
            chatId,
            projectId
          )
          .run();


        return json({
          success: true
        });

      }


      /* =====================================================
         EXISTING CHAT LIST
      ===================================================== */

      if (
        path === "/chats" &&
        request.method === "GET"
      ) {

        const result =
          await env.DB
            .prepare(`
              SELECT
                c.id,
                c.title,
                c.created_at,
                c.updated_at,
                c.total_prompt_tokens,
                c.total_completion_tokens,
                c.total_tokens,
                c.total_cost,
                cp.project_id
              FROM chats c
              LEFT JOIN chat_projects cp
                ON cp.chat_id = c.id
              ORDER BY c.updated_at DESC
              LIMIT 100
            `)
            .all();


        return json({
          success: true,
          chats:
            result.results || []
        });

      }


      /* =====================================================
         CREATE CHAT
      ===================================================== */

      if (
        path === "/chats" &&
        request.method === "POST"
      ) {

        const body =
          await safeJSON(request);


        const id =
          crypto.randomUUID();


        const now =
          Date.now();


        const title =
          cleanTitle(
            body?.title ||
            "New Chat"
          );


        await env.DB
          .prepare(`
            INSERT INTO chats (
              id,
              title,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?)
          `)
          .bind(
            id,
            title,
            now,
            now
          )
          .run();


        return json({
          success: true,

          chat: {
            id,
            title,
            created_at: now,
            updated_at: now,
            total_prompt_tokens: 0,
            total_completion_tokens: 0,
            total_tokens: 0,
            total_cost: 0
          }
        });

      }


      /* =====================================================
         SINGLE CHAT
      ===================================================== */

      const chatMatch =
        path.match(
          /^\/chats\/([^/]+)$/
        );


      if (chatMatch) {

        const chatId =
          decodeURIComponent(
            chatMatch[1]
          );


        if (
          request.method === "GET"
        ) {

          const chat =
            await env.DB
              .prepare(`
                SELECT
                  c.*,
                  cp.project_id
                FROM chats c
                LEFT JOIN chat_projects cp
                  ON cp.chat_id = c.id
                WHERE c.id = ?
                LIMIT 1
              `)
              .bind(chatId)
              .first();


          if (!chat) {

            return json(
              {
                success: false,
                error:
                  "Chat not found."
              },
              404
            );

          }


          const messagesResult =
            await env.DB
              .prepare(`
                SELECT
                  id,
                  role,
                  content,
                  created_at,
                  prompt_tokens,
                  completion_tokens,
                  total_tokens,
                  cost
                FROM messages
                WHERE chat_id = ?
                ORDER BY created_at ASC
              `)
              .bind(chatId)
              .all();


          return json({
            success: true,
            chat,
            messages:
              messagesResult.results || []
          });

        }


        if (
          request.method === "PATCH"
        ) {

          const body =
            await safeJSON(request);


          const title =
            cleanTitle(
              body?.title ||
              "New Chat"
            );


          await env.DB
            .prepare(`
              UPDATE chats
              SET
                title = ?,
                updated_at = ?
              WHERE id = ?
            `)
            .bind(
              title,
              Date.now(),
              chatId
            )
            .run();


          return json({
            success: true,
            title
          });

        }


        if (
          request.method === "DELETE"
        ) {

          await env.DB.batch([

            env.DB
              .prepare(`
                DELETE FROM chat_projects
                WHERE chat_id = ?
              `)
              .bind(chatId),

            env.DB
              .prepare(`
                DELETE FROM messages
                WHERE chat_id = ?
              `)
              .bind(chatId),

            env.DB
              .prepare(`
                DELETE FROM chats
                WHERE id = ?
              `)
              .bind(chatId)

          ]);


          return json({
            success: true
          });

        }

      }


      /* =====================================================
         AI CHAT
         POST /chat
      ===================================================== */

      if (
        path === "/chat" &&
        request.method === "POST"
      ) {

        if (
          !env.OPENROUTER_API_KEY
        ) {

          return json(
            {
              success: false,
              error:
                "OPENROUTER_API_KEY is missing."
            },
            500
          );

        }


        const body =
          await safeJSON(request);


        const prompt =
          String(
            body?.prompt || ""
          ).trim();


        const language =
          String(
            body?.language ||
            "auto"
          );


        const allowedAttachmentExtensions =
          new Set([
            "html", "htm", "css", "js", "mjs", "cjs",
            "ts", "jsx", "tsx", "json", "md", "txt",
            "py", "sql", "xml", "yaml", "yml", "csv"
          ]);


        const rawAttachments =
          Array.isArray(body?.attachments)
            ? body.attachments
            : [];


        if (rawAttachments.length > 5) {
          return json({ success: false, error: "A maximum of 5 temporary attachments is allowed per request." }, 400);
        }


        const attachments = [];
        let attachmentTotalBytes = 0;


        for (const item of rawAttachments) {
          const name = cleanFileName(item?.name);
          const content = String(item?.content ?? "");
          const extension = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
          const bytes = textEncoder.encode(content).byteLength;

          if (!name || !allowedAttachmentExtensions.has(extension)) {
            return json({ success: false, error: "Unsupported temporary attachment: " + String(item?.name || "unnamed file") }, 400);
          }
          if (bytes > 500 * 1024) {
            return json({ success: false, error: "Temporary attachment is larger than 500 KB: " + name }, 400);
          }
          if (content.includes("\0")) {
            return json({ success: false, error: "Binary files are not supported as temporary attachments: " + name }, 400);
          }

          attachmentTotalBytes += bytes;
          if (attachmentTotalBytes > 1024 * 1024) {
            return json({ success: false, error: "Combined temporary attachments exceed the 1 MB request limit." }, 400);
          }

          attachments.push({ name, content, bytes });
        }


        const requestedModel =
          String(
            body?.model ||
            "openrouter/free"
          ).trim();


        if (
          requestedModel !==
            "openrouter/free" &&
          !requestedModel.endsWith(
            ":free"
          )
        ) {

          return json(
            {
              success: false,
              error:
                "Only OpenRouter free models can be selected."
            },
            400
          );

        }


        const selectedModel =
          requestedModel ||
          "openrouter/free";


        let chatId =
          String(
            body?.chatId || ""
          ).trim();


        const projectId =
          String(
            body?.projectId || ""
          ).trim();


        if (!prompt) {

          return json(
            {
              success: false,
              error:
                "Prompt is empty."
            },
            400
          );

        }


        let chat = null;


        /*
          Get existing chat.
        */

        if (chatId) {

          chat =
            await env.DB
              .prepare(`
                SELECT *
                FROM chats
                WHERE id = ?
                LIMIT 1
              `)
              .bind(chatId)
              .first();

        }


        /*
          Create chat when first message
          is sent.
        */

        if (!chat) {

          chatId =
            crypto.randomUUID();


          const now =
            Date.now();


          const title =
            titleFromPrompt(
              prompt
            );


          await env.DB
            .prepare(`
              INSERT INTO chats (
                id,
                title,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?)
            `)
            .bind(
              chatId,
              title,
              now,
              now
            )
            .run();


          chat = {
            id: chatId,
            title
          };

        }


        /*
          Link to current project.
        */

        if (projectId) {

          await env.DB
            .prepare(`
              INSERT INTO chat_projects (
                chat_id,
                project_id
              )
              VALUES (?, ?)

              ON CONFLICT(chat_id)
              DO UPDATE SET
                project_id =
                  excluded.project_id
            `)
            .bind(
              chatId,
              projectId
            )
            .run();

        }


        /* Save user message */

        const userMessageId =
          crypto.randomUUID();


        const userTime =
          Date.now();


        await env.DB
          .prepare(`
            INSERT INTO messages (
              id,
              chat_id,
              role,
              content,
              created_at
            )
            VALUES (?, ?, ?, ?, ?)
          `)
          .bind(
            userMessageId,
            chatId,
            "user",
            prompt,
            userTime
          )
          .run();


        /*
          Conversation history
        */

        const history =
          await env.DB
            .prepare(`
              SELECT
                role,
                content
              FROM messages
              WHERE chat_id = ?
              ORDER BY created_at ASC
            `)
            .bind(chatId)
            .all();


        const conversation =
          (
            history.results ||
            []
          )
          .filter(
            item =>
              item.role === "user" ||
              item.role === "assistant"
          )
          .map(
            item => ({
              role:
                item.role,
              content:
                item.content
            })
          );


        /*
          Project context
        */

        let projectContext =
          "";


        let projectFiles =
          [];


        if (projectId) {

          const project =
            await env.DB
              .prepare(`
                SELECT *
                FROM projects
                WHERE id = ?
                LIMIT 1
              `)
              .bind(projectId)
              .first();


          const projectFileResult =
            await env.DB
              .prepare(`
                SELECT
                  id,
                  name,
                  content,
                  language
                FROM project_files
                WHERE project_id = ?
                ORDER BY name ASC
              `)
              .bind(projectId)
              .all();


          projectFiles =
            projectFileResult.results ||
            [];


          if (project) {

            projectContext += `

CURRENT PROJECT:
${project.name}

`;

          }


          if (
            projectFiles.length
          ) {

            projectContext +=
              "PROJECT FILES:\n\n";


            for (
              const file of
              projectFiles
            ) {

              projectContext +=
                `===== FILE: ${file.name} =====\n` +
                `${file.content}\n\n`;

            }

          }

        }


        /*
          Temporary attachments. These are request-only and are
          deliberately not inserted into D1 or conversation history.
        */

        let attachmentContext = "";

        if (attachments.length) {
          attachmentContext += `

TEMPORARY USER ATTACHMENTS:
These files were attached only for this request. Review them as requested.
Do not assume they are stored in the current project, and do not modify
project files merely because an attachment has the same filename.

`;

          for (const attachment of attachments) {
            attachmentContext +=
              `===== TEMP ATTACHMENT: ${attachment.name} =====\n` +
              `${attachment.content}\n\n`;
          }
        }


        /*
          System prompt
        */

        let systemPrompt = `

You are CodePilot, an expert software engineering assistant.

You help users:
- write complete working code
- debug code
- explain code
- improve code
- build websites
- build applications
- create APIs
- work with databases
- solve programming problems.

If a project is attached, its files are supplied below.

IMPORTANT PROJECT EDITING RULES:

When the user asks you to change project files:

1. Explain briefly what you changed.
2. Return a machine-readable project update block after the explanation.
3. The update block MUST use exactly this format:

<<<CODEPILOT_FILES>>>
[
  {
    "name": "index.html",
    "content": "FULL FILE CONTENT"
  }
]
<<<END_CODEPILOT_FILES>>>

4. Include the COMPLETE contents of every file you modify.
5. Do not include unchanged files.
6. Do not invent a file unless the change genuinely requires one.
7. The JSON inside the block must be valid JSON.
8. Never place Markdown code fences around the CODEPILOT_FILES block.

For ordinary questions that do not modify project files,
respond normally using Markdown.

RESPONSE FORMATTING RULES:
- Use standard GitHub-Flavored Markdown only.
- Do not use raw HTML tags such as <br> for line breaks.
- Markdown tables must include a normal header row and separator row.
- For fenced code blocks, put the language on the opening fence and start the code on the next real line.
- Do not imitate Markdown with doubled pipes or HTML line-break text.

`;


        if (
          language &&
          language !== "auto"
        ) {

          systemPrompt += `

Preferred programming language:
${language}

`;

        }


        systemPrompt +=
          projectContext;


        systemPrompt +=
          attachmentContext;


        /*
          OpenRouter
        */

        const openRouterResponse =
          await fetch(
            "https://openrouter.ai/api/v1/chat/completions",
            {

              method:
                "POST",

              headers: {

                "Authorization":
                  "Bearer " +
                  env.OPENROUTER_API_KEY,

                "Content-Type":
                  "application/json",

                "X-OpenRouter-Title":
                  "CodePilot"

              },

              body:
                JSON.stringify({

                  model:
                    selectedModel,

                  messages: [

                    {
                      role:
                        "system",

                      content:
                        systemPrompt
                    },

                    ...conversation

                  ],

                  usage: {
                    include: true
                  }

                })

            }
          );


        const responseText =
          await openRouterResponse
            .text();


        if (
          !openRouterResponse.ok
        ) {

          return json(
            {
              success: false,
              chatId,
              error:
                "OpenRouter HTTP " +
                openRouterResponse.status,
              details:
                responseText
            },
            openRouterResponse.status
          );

        }


        let data;


        try {

          data =
            JSON.parse(
              responseText
            );

        }

        catch {

          return json(
            {
              success: false,
              chatId,
              error:
                "OpenRouter returned invalid JSON."
            },
            500
          );

        }


        const rawAnswer =
          data?.choices?.[0]
            ?.message?.content;


        if (!rawAnswer) {

          return json(
            {
              success: false,
              chatId,
              error:
                "AI returned an empty response."
            },
            500
          );

        }


        /*
          Parse optional project edits.
        */

        const parsed =
          parseProjectUpdates(
            rawAnswer
          );


        const answer =
          parsed.displayText;


        const fileUpdates =
          parsed.files;


        /*
          Apply AI-generated file updates.
        */

        const appliedFiles =
          [];


        if (
          projectId &&
          fileUpdates.length
        ) {

          for (
            const update of
            fileUpdates
          ) {

            const fileName =
              cleanFileName(
                update?.name
              );


            const content =
              String(
                update?.content ??
                ""
              );


            if (
              !fileName ||
              content.length >
              500000
            ) {

              continue;

            }


            const existing =
              projectFiles.find(
                file =>
                  file.name ===
                  fileName
              );


            const now =
              Date.now();


            if (existing) {

              await env.DB
                .prepare(`
                  UPDATE project_files
                  SET
                    content = ?,
                    language = ?,
                    updated_at = ?
                  WHERE
                    id = ?
                    AND project_id = ?
                `)
                .bind(
                  content,
                  languageFromFilename(
                    fileName
                  ),
                  now,
                  existing.id,
                  projectId
                )
                .run();


              appliedFiles.push({
                id:
                  existing.id,
                name:
                  fileName,
                content,
                language:
                  languageFromFilename(
                    fileName
                  )
              });

            }

            else {

              const id =
                crypto.randomUUID();


              await env.DB
                .prepare(`
                  INSERT INTO project_files (
                    id,
                    project_id,
                    name,
                    content,
                    language,
                    created_at,
                    updated_at
                  )
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                `)
                .bind(
                  id,
                  projectId,
                  fileName,
                  content,
                  languageFromFilename(
                    fileName
                  ),
                  now,
                  now
                )
                .run();


              appliedFiles.push({
                id,
                name:
                  fileName,
                content,
                language:
                  languageFromFilename(
                    fileName
                  )
              });

            }

          }


          await env.DB
            .prepare(`
              UPDATE projects
              SET updated_at = ?
              WHERE id = ?
            `)
            .bind(
              Date.now(),
              projectId
            )
            .run();

        }


        /*
          Usage
        */

        const usage =
          data?.usage || {};


        const promptTokens =
          Number(
            usage.prompt_tokens || 0
          );


        const completionTokens =
          Number(
            usage.completion_tokens || 0
          );


        const totalTokens =
          Number(
            usage.total_tokens ||
            (
              promptTokens +
              completionTokens
            )
          );


        const cost =
          Number(
            usage.cost || 0
          );


        /*
          Save assistant message
        */

        const aiMessageId =
          crypto.randomUUID();


        const aiTime =
          Date.now();


        await env.DB.batch([

          env.DB
            .prepare(`
              INSERT INTO messages (
                id,
                chat_id,
                role,
                content,
                created_at,
                prompt_tokens,
                completion_tokens,
                total_tokens,
                cost
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              aiMessageId,
              chatId,
              "assistant",
              answer,
              aiTime,
              promptTokens,
              completionTokens,
              totalTokens,
              cost
            ),

          env.DB
            .prepare(`
              UPDATE chats
              SET
                updated_at = ?,
                total_prompt_tokens =
                  total_prompt_tokens + ?,
                total_completion_tokens =
                  total_completion_tokens + ?,
                total_tokens =
                  total_tokens + ?,
                total_cost =
                  total_cost + ?
              WHERE id = ?
            `)
            .bind(
              aiTime,
              promptTokens,
              completionTokens,
              totalTokens,
              cost,
              chatId
            )

        ]);


        const updatedChat =
          await env.DB
            .prepare(`
              SELECT
                c.*,
                cp.project_id
              FROM chats c
              LEFT JOIN chat_projects cp
                ON cp.chat_id = c.id
              WHERE c.id = ?
              LIMIT 1
            `)
            .bind(chatId)
            .first();


        return json({

          success:
            true,

          chatId,

          chat:
            updatedChat,

          answer,

          modelRequested:
            selectedModel,

          modelUsed:
            String(
              data?.model ||
              selectedModel
            ),

          filesUpdated:
            appliedFiles,

          usage: {
            promptTokens,
            completionTokens,
            totalTokens,
            cost
          }

        });

      }


      /* =====================================================
         USAGE
      ===================================================== */

      if (
        path === "/usage" &&
        request.method === "GET"
      ) {

        const local =
          await env.DB
            .prepare(`
              SELECT
                COUNT(*) AS chat_count,
                COALESCE(
                  SUM(total_prompt_tokens),
                  0
                ) AS prompt_tokens,
                COALESCE(
                  SUM(total_completion_tokens),
                  0
                ) AS completion_tokens,
                COALESCE(
                  SUM(total_tokens),
                  0
                ) AS total_tokens,
                COALESCE(
                  SUM(total_cost),
                  0
                ) AS total_cost
              FROM chats
            `)
            .first();


        let keyUsage =
          null;


        if (
          env.OPENROUTER_API_KEY
        ) {

          try {

            const keyResponse =
              await fetch(
                "https://openrouter.ai/api/v1/key",
                {
                  headers: {
                    "Authorization":
                      "Bearer " +
                      env.OPENROUTER_API_KEY
                  }
                }
              );


            if (
              keyResponse.ok
            ) {

              const keyJSON =
                await keyResponse.json();


              keyUsage =
                keyJSON?.data ||
                keyJSON;

            }

          }

          catch (
            error
          ) {

            console.error(
              "Usage error:",
              error
            );

          }

        }


        let accountCredits =
          null;


        if (
          env.OPENROUTER_MANAGEMENT_KEY
        ) {

          try {

            const creditResponse =
              await fetch(
                "https://openrouter.ai/api/v1/credits",
                {
                  headers: {
                    "Authorization":
                      "Bearer " +
                      env.OPENROUTER_MANAGEMENT_KEY
                  }
                }
              );


            if (
              creditResponse.ok
            ) {

              const creditJSON =
                await creditResponse.json();


              const creditData =
                creditJSON?.data ||
                creditJSON;


              const totalCredits =
                Number(
                  creditData
                    ?.total_credits ??
                  creditData
                    ?.credits ??
                  0
                );


              const totalUsage =
                Number(
                  creditData
                    ?.total_usage ??
                  creditData
                    ?.usage ??
                  0
                );


              accountCredits = {
                totalCredits,
                totalUsage,
                remaining:
                  Math.max(
                    0,
                    totalCredits -
                    totalUsage
                  )
              };

            }

          }

          catch (
            error
          ) {

            console.error(
              "Credit error:",
              error
            );

          }

        }


        return json({
          success: true,
          local:
            local || {},
          key:
            keyUsage,
          account:
            accountCredits
        });

      }


      return json(
        {
          success: false,
          error: "Route not found."
        },
        404
      );

    }

    catch (
      error
    ) {

      console.error(
        "Worker error:",
        error
      );


      return json(
        {
          success: false,
          error:
            error?.message ||
            "Unknown Worker error."
        },
        500
      );

    }

  }

};


/* =========================================================
   HELPERS
========================================================= */

async function safeJSON(
  request
) {

  try {

    return await request.json();

  }

  catch {

    return {};

  }

}


function cleanTitle(
  value
) {

  const title =
    String(
      value ||
      "New Chat"
    )
    .replace(/\s+/g, " ")
    .trim();


  return (
    title.slice(
      0,
      80
    ) ||
    "New Chat"
  );

}


function titleFromPrompt(
  prompt
) {

  let title =
    String(prompt)
      .replace(
        /```[\s\S]*?```/g,
        "Code"
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();


  if (
    title.length > 48
  ) {

    title =
      title
        .slice(
          0,
          48
        )
        .trim() +
      "…";

  }


  return (
    title ||
    "New Chat"
  );

}


function cleanProjectName(
  value
) {

  const name =
    String(
      value ||
      "Untitled Project"
    )
    .replace(/\s+/g, " ")
    .trim();


  return (
    name.slice(
      0,
      80
    ) ||
    "Untitled Project"
  );

}


function cleanFileName(
  value
) {

  const name =
    String(
      value || ""
    )
      .trim()
      .replace(
        /[\\:*?"<>|]/g,
        ""
      )
      .replace(
        /\.\./g,
        "."
      );


  if (
    !name ||
    name === "." ||
    name === "/"
  ) {

    return "";

  }


  return name.slice(
    0,
    120
  );

}


function languageFromFilename(
  filename
) {

  const extension =
    String(filename)
      .toLowerCase()
      .split(".")
      .pop();


  const languages = {
    html: "html",
    htm: "html",
    css: "css",
    js: "javascript",
    mjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    jsx: "javascript",
    json: "json",
    py: "python",
    php: "php",
    java: "java",
    cpp: "cpp",
    c: "c",
    cs: "csharp",
    sql: "sql",
    md: "markdown",
    txt: "plaintext"
  };


  return (
    languages[
      extension
    ] ||
    "plaintext"
  );

}


function defaultHTML(
  projectName
) {

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >
  <title>${escapeHTMLText(projectName)}</title>
  <link
    rel="stylesheet"
    href="style.css"
  >
</head>

<body>

  <main>
    <h1>${escapeHTMLText(projectName)}</h1>
    <p>Your CodePilot project is ready.</p>
  </main>

  <script src="script.js"><\/script>

</body>
</html>`;
}


function defaultCSS() {

  return `* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;

  display: grid;
  place-items: center;

  font-family: Arial, sans-serif;

  background: #111;
  color: #fff;
}

main {
  text-align: center;
}`;
}


function defaultJS() {

  return `console.log("CodePilot project loaded.");`;
}


function escapeHTMLText(
  value
) {

  return String(value)
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );

}


/* =========================================================
   PARSE AI FILE UPDATES
========================================================= */

function parseProjectUpdates(
  response
) {

  const text =
    String(
      response || ""
    );


  const pattern =
    /<<<CODEPILOT_FILES>>>\s*([\s\S]*?)\s*<<<END_CODEPILOT_FILES>>>/;


  const match =
    text.match(
      pattern
    );


  if (!match) {

    return {
      displayText:
        text,
      files: []
    };

  }


  let files = [];


  try {

    const parsed =
      JSON.parse(
        match[1]
      );


    if (
      Array.isArray(
        parsed
      )
    ) {

      files =
        parsed.filter(
          item =>
            item &&
            typeof item.name ===
              "string" &&
            typeof item.content ===
              "string"
        );

    }

  }

  catch (
    error
  ) {

    console.error(
      "AI project update parse failed:",
      error
    );

  }


  const displayText =
    text
      .replace(
        pattern,
        ""
      )
      .trim();


  return {
    displayText:
      displayText ||
      (
        files.length
          ? "Project files updated."
          : text
      ),

    files
  };

}