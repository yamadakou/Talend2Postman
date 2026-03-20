#!/usr/bin/env node

const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const SCHEMA_V2_1 = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";
const POSTMAN_VARIABLE_TYPE_DEFAULT = "default";


function replaceVariables(value) {
  if (typeof value === "string" && value.includes("${")) {
    return value.replace(/\$\{([^}]+)\}/g, "{{$1}}");
  }
  return value;
}

function buildAssertionTestScript(assertions) {
  if (!Array.isArray(assertions) || assertions.length === 0) {
    return null;
  }

  const lines = [];
  assertions.forEach((assertion) => {
    const subject = assertion.subject;
    const path = assertion.path;
    const comparison = assertion.comparison;
    const value = assertion.value;

    if (subject === "ResponseStatus" && path === "code" && comparison === "Equals") {
      const statusCode = parseInt(value, 10);
      if (!isNaN(statusCode)) {
        lines.push(
          `pm.test("Status code is ${statusCode}", function () { pm.response.to.have.status(${statusCode}); });`
        );
      } else {
        lines.push(
          `// Unsupported assertion: subject=${subject}, path=${path}, comparison=${comparison}, value=${value}`
        );
      }
    } else {
      lines.push(
        `// Unsupported assertion: subject=${subject}, path=${path}, comparison=${comparison}, value=${value}`
      );
    }
  });

  if (lines.length === 0) {
    return null;
  }

  return {
    listen: "test",
    script: {
      type: "text/javascript",
      exec: lines
    }
  };
}

function buildPostmanQuery(uri) {
  const queryItems = uri?.query?.items || [];
  return queryItems
    .filter((q) => q.enabled !== false)
    .map((q) => ({
      key: replaceVariables(q.name),
      value: replaceVariables(q.value)
    }));
}

function talendRequestToPostmanItem(talendRequest) {
  const { id, name, method, headers, uri, body, assertions } = talendRequest;

  const postmanMethod = method?.name || "GET";

  let scheme = replaceVariables(uri?.scheme?.name || "http").replace(":", "");
  let host = replaceVariables(uri?.host || "localhost");
  let trimmedPath = replaceVariables((uri?.path || "").replace(/^\/+/, ""));

  let rawUrl = `${scheme}://${host}`;
  if (trimmedPath) {
    rawUrl += `/${trimmedPath}`;
  }

  const postmanQuery = buildPostmanQuery(uri);

  if (postmanQuery.length > 0) {
    const queryString = postmanQuery
      .map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value)}`)
      .join("&");
    rawUrl += `?${queryString}`;
  }

  const [hostWithoutPort, portMaybe] = host.split(":");

  const postmanUrl = {
    raw: rawUrl,
    protocol: scheme,
    host: replaceVariables(hostWithoutPort).split("."),
    path: trimmedPath ? trimmedPath.split("/") : []
  };

  if (portMaybe) {
    postmanUrl.port = portMaybe;
  }

  if (postmanQuery.length > 0) {
    postmanUrl.query = postmanQuery;
  }

  const postmanHeaders = [];
  if (Array.isArray(headers)) {
    headers.forEach((h) => {
      if (h.enabled) {
        postmanHeaders.push({
          key: h.name,
          value: replaceVariables(h.value)
        });
      }
    });
  }

  let postmanBody = { mode: "raw", raw: "" };
  let contentTypeHeader = postmanHeaders.find(
    (hdr) => hdr.key.toLowerCase() === "content-type"
  );
  let contentType = contentTypeHeader ? contentTypeHeader.value.toLowerCase() : "";

  const formBody = body?.formBody || {};
  const formItems = formBody?.items || [];

  if (Array.isArray(formItems) && formItems.length > 0) {
    if (/x-www-form-urlencoded/i.test(formBody.encoding)) {
      postmanBody.mode = "urlencoded";
      postmanBody.urlencoded = formItems.map((fi) => ({
        key: fi.name,
        value: replaceVariables(fi.value),
        type: "text"
      }));
    } else if (/multipart\/form-data/i.test(formBody.encoding)) {
      postmanBody.mode = "formdata";
      postmanBody.formdata = formItems.map((fi) => ({
        key: fi.name,
        value: replaceVariables(fi.value),
        type: fi.type === "file" ? "file" : "text"
      }));
    } else {
      postmanBody = {
        mode: "raw",
        raw: replaceVariables(body?.textBody || ""),
        options: { raw: { language: "text" } }
      };
    }
  } else {
    const textBody = body?.textBody || "";
    if (contentType.includes("application/json")) {
      postmanBody.mode = "raw";
      postmanBody.raw = replaceVariables(textBody);
      postmanBody.options = { raw: { language: "json" } };
    } else if (textBody) {
      postmanBody.mode = "raw";
      postmanBody.raw = replaceVariables(textBody);
      postmanBody.options = { raw: { language: "text" } };
    } else {
      postmanBody.mode = "raw";
      postmanBody.raw = "";
    }
  }

  const item = {
    name: name || `Request ${id}`,
    request: {
      method: postmanMethod,
      header: postmanHeaders,
      body: postmanBody,
      url: postmanUrl
    },
    response: []
  };

  const testEvent = buildAssertionTestScript(assertions);
  if (testEvent) {
    item.event = [testEvent];
  }

  return item;
}

function talendNodeToPostmanItem(node) {
  if (!node || !node.entity) return null;

  const { entity } = node;

  if (entity.type === "Request") {
    return talendRequestToPostmanItem(entity);
  }

  const children = Array.isArray(node.children) ? node.children : [];
  const childItems = children
    .map((child) => talendNodeToPostmanItem(child))
    .filter(Boolean);

  return {
    name: entity.name || `Unnamed ${entity.type || "Folder"}`,
    item: childItems
  };
}

function talendServiceToPostmanFolder(serviceNode) {
  return talendNodeToPostmanItem(serviceNode);
}

function talendProjectToPostmanCollection(projectNode) {
  const projectEntity = projectNode.entity;
  const projectName = projectEntity.name || "Unnamed Project";

  const items = [];
  if (Array.isArray(projectNode.children)) {
    projectNode.children.forEach((serviceChild) => {
      if (serviceChild.entity && serviceChild.entity.type === "Service") {
        items.push(talendServiceToPostmanFolder(serviceChild));
      }
    });
  }

  return {
    info: {
      _postman_id: uuidv4(),
      name: projectName,
      schema: SCHEMA_V2_1,
      _exporter_id: "talend2postman"
    },
    item: items
  };
}

function convertTalendToPostman(talendJson) {
  const projects = talendJson.entities || [];

  return projects
    .filter((p) => p.entity && p.entity.type === "Project")
    .map((project) => talendProjectToPostmanCollection(project));
}

function convertTalendEnvironmentToPostman(talendJson) {
  const environments = talendJson.environments;
  if (!Array.isArray(environments) || environments.length === 0) {
    return [];
  }

  return environments.map((env) => {
    const values = Object.values(env.variables || {}).map((v) => ({
      key: v.name,
      value: v.value !== undefined ? v.value : "",
      enabled: v.enabled !== false,
      type: POSTMAN_VARIABLE_TYPE_DEFAULT
    }));

    return {
      id: env.id,
      name: env.name,
      values,
      _postman_variable_scope: "environment",
      _postman_exported_at: new Date().toISOString(),
      _postman_exported_using: "Talend2Postman"
    };
  });
}


function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: node talend2postman.js <input.json> <output.json>");
    process.exit(1);
  }

  const inputFile = args[0];
  const outputFile = args[1];

  if (!fs.existsSync(inputFile)) {
    console.error("Error: Input file does not exist:", inputFile);
    process.exit(1);
  }

  let talendData;
  try {
    const rawData = fs.readFileSync(inputFile, "utf8");
    talendData = JSON.parse(rawData);
  } catch (err) {
    console.error("Error parsing input JSON:", err);
    process.exit(1);
  }

  let results;
  if (Array.isArray(talendData.environments)) {
    results = convertTalendEnvironmentToPostman(talendData);
  } else {
    results = convertTalendToPostman(talendData);
  }

  let outputJson;
  if (results.length === 1) {
    outputJson = JSON.stringify(results[0], null, 2);
  } else {
    outputJson = JSON.stringify(results, null, 2);
  }

  try {
    fs.writeFileSync(outputFile, outputJson, "utf8");
    console.log(`Successfully wrote Postman collection(s) to: ${outputFile}`);
  } catch (err) {
    console.error("Error writing output file:", err);
    process.exit(1);
  }
}

main();
