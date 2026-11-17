---
title: Prisma Compute
description: 'Deploy your Nuxt Application to Prisma Compute infrastructure.'
logoIcon: 'i-simple-icons-prisma'
category: Hosting
nitroPreset: 'node'
website: 'https://www.prisma.io/compute'
---

Nuxt supports deploying on [Prisma Compute](https://www.prisma.io/compute) with the default Node.js server output. You describe your app in TypeScript with [Prisma Composer](https://www.prisma.io/docs/composer) and deploy it with the Prisma CLI.

## Setup

1. Install the Composer packages and the Prisma CLI.

    ```bash [Terminal]
    npm install @prisma/composer @prisma/composer-prisma-cloud
    npm install -D prisma
    ```

2. Create a `service.ts` file in your project's root directory. It declares the service and points to the `.output` directory that `nuxt build` generates.

    ```ts [service.ts]
    import node from '@prisma/composer/node'
    import { compute } from '@prisma/composer-prisma-cloud'

    export default compute({
      name: 'app',
      deps: {},
      build: node({
        module: import.meta.url,
        dir: './.output',
        entry: 'server/index.mjs',
      }),
    })
    ```

3. Create a `module.ts` file next to it. The module name becomes the name of your project on Prisma Compute.

    ```ts [module.ts]
    import { module } from '@prisma/composer'
    import app from './service.ts'

    export default module('my-nuxt-app', ({ provision }) => {
      provision(app)
    })
    ```

4. Create a `prisma.config.ts` file. The `region` is where the first deployment creates your project.

    ```ts [prisma.config.ts]
    import { defineConfig as composer } from '@prisma/composer/config'
    import { nodeBuild } from '@prisma/composer/node/control'
    import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control'
    import { definePrismaConfig } from 'prisma/config'

    export default definePrismaConfig({
      composer: composer({
        entry: './module.ts',
        extensions: [prismaCloud({ region: 'eu-central-1' }), nodeBuild()],
        state: prismaState(),
      }),
    })
    ```

5. Sign in to your [Prisma account](https://console.prisma.io), then build and deploy your app. The CLI prints the public URL of your app when the deployment finishes. Run the last two commands again to deploy subsequent changes.

    ```bash [Terminal]
    npx prisma auth login
    npm run build
    npx prisma deploy
    ```

::note
The CLI writes local state to `.alchemy` and `.prisma-composer`. Add both directories to your `.gitignore`.
::

## Database

Your service can declare a [Prisma Postgres](https://www.prisma.io/postgres) database as a dependency. The deployment then creates the database and passes the connection string to your app, so there is no environment variable to set.

1. Add the dependency to `service.ts`.

    ```ts [service.ts]
    import node from '@prisma/composer/node'
    import { compute, rawPostgres } from '@prisma/composer-prisma-cloud'

    export default compute({
      name: 'app',
      deps: { db: rawPostgres() },
      build: node({
        module: import.meta.url,
        dir: './.output',
        entry: 'server/index.mjs',
      }),
    })
    ```

2. Provision the database in `module.ts` and pass it to the service.

    ```ts [module.ts]
    import { module } from '@prisma/composer'
    import { rawPostgres } from '@prisma/composer-prisma-cloud'
    import app from './service.ts'

    export default module('my-nuxt-app', ({ provision }) => {
      const db = provision(rawPostgres({ name: 'database' }))
      provision(app, { deps: { db } })
    })
    ```

3. Read the connection string from `service.load()` in your server routes and use it with any PostgreSQL client. This example uses [`pg`](https://node-postgres.com).

    ```ts [server/api/now.get.ts]
    import pg from 'pg'
    import service from '~~/service'

    export default defineEventHandler(async () => {
      const client = new pg.Client({ connectionString: service.load().db.url })
      await client.connect()
      try {
        const { rows } = await client.query('select now()')
        return rows[0]
      } finally {
        await client.end()
      }
    })
    ```

Prisma Compute suspends an app that receives no requests, and a database connection that was open at that point is no longer usable when the app resumes. The example therefore opens a connection for each request instead of keeping a pool.

The connection string is only available when Composer starts your app. To run it locally, build it and use `npx prisma dev` instead of `nuxt dev`. It starts a local PostgreSQL database and prints the local URL of your app.

## Learn more

::read-more{to="https://www.prisma.io/docs/guides/frameworks/nuxt" target="_blank"}
Head over to **Prisma documentation** to learn more about running Nuxt on Prisma Compute.
::
