# Synthetic read-only assistant evaluations

All data in this directory is synthetic and safe to commit to a public repository. The fictional **Example Makers** cohort explores paper bridges. UUIDs, lesson text, worksheet paths, event dates, and reserved `example.com` links are dummy fixtures, authored only for tests. Nothing is copied from paid course materials, live records, instructor files, or people data.

`evaluation.xml` contains 10 independent questions with stable answers. They exercise cohort lookup, module/lesson traversal, resource filtering, pagination, attachment counts, and UTC schedule reasoning across the EDT/EST transition.

Use **this fixture server**, never production, when answering the questions:

```sh
cd mcp
npm ci
npm run build
node evaluations/server.mjs
```

It exposes the same MCP tool schemas against an isolated loopback fixture. Writes remain disabled. It never loads production configuration or credentials. The default test suite needs only this repository and package dependencies; it does not require any private course directory or environment file.

`verify.mjs` obtains the answers through the tool handlers, with a one-row page size to exercise pagination. The test suite compares all 10 expected answers. This verifies the dataset and expected answers; it does not claim an external model has passed the evaluation. Connect an MCP-capable assistant to the fixture server and supply the questions individually to measure model performance.
