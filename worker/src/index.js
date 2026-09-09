export default {

  async fetch(request, env) {

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods":
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type"
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