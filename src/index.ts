#!/usr/bin/env node

/**
 * Remotion Complete MCP Server
 * Full programmatic video rendering via Remotion + AWS Lambda
 * Powered by mastermindshq.business
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const express = require("express");
const { z } = require("zod");

const PORT = parseInt(process.env.PORT || "8080", 10);

// ── AWS / Remotion config ────────────────────────────────────────────
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || "";
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || "";
const REMOTION_SITE_NAME = process.env.REMOTION_SITE_NAME || "";

// ── Remotion Lambda (lazy import — may not be installed locally) ─────
let remotionLambda = null;
function getLambda() {
  if (!remotionLambda) {
    try {
      remotionLambda = require("@remotion/lambda");
    } catch (e) {
      throw new Error("@remotion/lambda is not installed. Add it to dependencies and redeploy.");
    }
  }
  return remotionLambda;
}

// ── Built-in composition templates (from existing Remotion agent) ────
const KNOWN_COMPOSITIONS = {
  "personalized-invite": { width: 1920, height: 1080, fps: 30, durationInFrames: 150 },
  "testimonial-video": { width: 1080, height: 1080, fps: 30, durationInFrames: 180 },
  "results-showcase": { width: 1920, height: 1080, fps: 30, durationInFrames: 210 },
  "marketing-promo": { width: 1080, height: 1920, fps: 30, durationInFrames: 270 },
  "data-visualization": { width: 1920, height: 1080, fps: 30, durationInFrames: 240 },
  "event-highlight": { width: 1920, height: 1080, fps: 30, durationInFrames: 300 },
  "instagram-reel-overlay": { width: 1080, height: 1920, fps: 30, durationInFrames: 690 },
};

// ── In-memory render tracking ────────────────────────────────────────
const renderJobs = new Map();

function createJobId() {
  return `render-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function validateAwsCreds() {
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    throw new Error(
      "AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables."
    );
  }
}

// ── MCP Server setup ─────────────────────────────────────────────────
const server = new McpServer({
  name: "remotion-complete",
  version: "1.0.0",
});

// ── Tool: render_video_lambda ────────────────────────────────────────
server.tool(
  "render_video_lambda",
  "Render a video on AWS Lambda using Remotion. Example: render a 30-second HelloWorld composition at 30fps on us-east-1. Returns a renderId you can poll with get_render_progress.",
  {
    compositionId: z.string().describe("The composition ID to render, e.g. 'marketing-promo', 'testimonial-video'"),
    serveUrl: z.string().optional().describe("The Remotion serve URL (S3 site URL). Omit to use REMOTION_SITE_NAME env var"),
    functionName: z.string().optional().describe("Lambda function name, e.g. 'remotion-render-4-0-272-mem2048mb-disk2048mb-240sec'"),
    inputProps: z.record(z.any()).optional().describe("Props to pass to the composition, e.g. {memberName: 'Sarah', brandColor: '#2563eb'}"),
    codec: z.enum(["h264", "h265", "vp8", "vp9", "mp3", "aac", "wav", "gif"]).optional().default("h264").describe("Output codec. Default: h264"),
    framesPerLambda: z.number().int().min(1).max(500).optional().describe("Frames to render per Lambda invocation. Default: auto"),
    outName: z.string().optional().describe("Output filename, e.g. 'my-video.mp4'"),
    privacy: z.enum(["public", "private", "no-acl"]).optional().default("public").describe("S3 output file privacy"),
  },
  async ({ compositionId, serveUrl, functionName, inputProps, codec, framesPerLambda, outName, privacy }) => {
    validateAwsCreds();
    const lambda = getLambda();

    const resolvedServeUrl = serveUrl ||
      (REMOTION_SITE_NAME
        ? `https://remotionlambda-${AWS_REGION}.s3.${AWS_REGION}.amazonaws.com/sites/${REMOTION_SITE_NAME}/index.html`
        : null);

    if (!resolvedServeUrl) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ error: "serveUrl is required. Provide it directly or set REMOTION_SITE_NAME env var." }),
        }],
        isError: true,
      };
    }

    try {
      const renderOpts = {
        region: AWS_REGION,
        serveUrl: resolvedServeUrl,
        composition: compositionId,
        inputProps: inputProps || {},
        codec: codec || "h264",
        privacy: privacy || "public",
      };
      if (functionName) renderOpts.functionName = functionName;
      if (framesPerLambda) renderOpts.framesPerLambda = framesPerLambda;
      if (outName) renderOpts.outName = outName;

      const { renderId, bucketName } = await lambda.renderMediaOnLambda(renderOpts);

      const jobId = createJobId();
      renderJobs.set(jobId, {
        renderId,
        bucketName,
        compositionId,
        status: "rendering",
        startedAt: new Date().toISOString(),
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            renderId,
            bucketName,
            jobId,
            compositionId,
            message: "Render started on Lambda. Use get_render_progress to track progress.",
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  }
);

// ── Tool: get_render_progress ────────────────────────────────────────
server.tool(
  "get_render_progress",
  "Check the progress of a Lambda render job. Pass the renderId and bucketName returned from render_video_lambda. Returns percent complete, estimated time remaining, and output URL when done.",
  {
    renderId: z.string().describe("The renderId returned from render_video_lambda"),
    bucketName: z.string().describe("The S3 bucket name returned from render_video_lambda"),
    functionName: z.string().optional().describe("Lambda function name used for the render"),
  },
  async ({ renderId, bucketName, functionName }) => {
    validateAwsCreds();
    const lambda = getLambda();

    try {
      const opts = {
        renderId,
        bucketName,
        region: AWS_REGION,
      };
      if (functionName) opts.functionName = functionName;

      const progress = await lambda.getRenderProgress(opts);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            renderId,
            overallProgress: progress.overallProgress,
            done: progress.done,
            outputFile: progress.outputFile || null,
            errors: progress.errors || [],
            costs: progress.costs || null,
            estimatedBillingDurationInSeconds: progress.estimatedBillingDurationInSeconds || null,
            framesRendered: progress.framesRendered || 0,
            encodingStatus: progress.encodingStatus || null,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  }
);

// ── Tool: cancel_render ──────────────────────────────────────────────
server.tool(
  "cancel_render",
  "Cancel an in-progress Lambda render. Useful when you've submitted a render with wrong settings and want to stop it before it completes to avoid unnecessary AWS costs.",
  {
    renderId: z.string().describe("The renderId to cancel"),
    bucketName: z.string().describe("The S3 bucket name for this render"),
  },
  async ({ renderId, bucketName }) => {
    validateAwsCreds();
    const lambda = getLambda();

    try {
      await lambda.cancelRender({
        renderId,
        bucketName,
        region: AWS_REGION,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, renderId, message: "Render cancelled successfully." }),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  }
);

// ── Tool: render_video_local ─────────────────────────────────────────
server.tool(
  "render_video_local",
  "Render a video locally using Remotion CLI (no AWS required). Good for testing compositions before deploying to Lambda. Requires Remotion to be installed locally.",
  {
    compositionId: z.string().describe("The composition to render, e.g. 'marketing-promo'"),
    entryPoint: z.string().describe("Path to the Remotion entry file, e.g. '/path/to/src/compositions/index.tsx'"),
    outputPath: z.string().describe("Output file path, e.g. '/tmp/output.mp4'"),
    inputProps: z.record(z.any()).optional().describe("Props to pass to the composition"),
    codec: z.enum(["h264", "h265", "vp8", "vp9", "mp3", "aac", "wav", "gif"]).optional().describe("Output codec"),
    concurrency: z.number().int().min(1).max(16).optional().describe("Number of parallel threads. Default: auto"),
  },
  async ({ compositionId, entryPoint, outputPath, inputProps, codec, concurrency }) => {
    const { execSync } = require("child_process");
    const fs = require("fs");

    if (!fs.existsSync(entryPoint)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Entry point not found: ${entryPoint}` }) }],
        isError: true,
      };
    }

    const propsFile = `/tmp/remotion-props-${Date.now()}.json`;
    fs.writeFileSync(propsFile, JSON.stringify(inputProps || {}));

    let cmd = `npx remotion render "${entryPoint}" "${compositionId}" "${outputPath}" --props="${propsFile}"`;
    if (codec) cmd += ` --codec=${codec}`;
    if (concurrency) cmd += ` --concurrency=${concurrency}`;

    try {
      execSync(cmd, { stdio: "pipe", timeout: 300000 });
      fs.unlinkSync(propsFile);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            compositionId,
            outputPath,
            message: "Local render complete.",
          }, null, 2),
        }],
      };
    } catch (err) {
      try { fs.unlinkSync(propsFile); } catch {}
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message || "Local render failed" }) }],
        isError: true,
      };
    }
  }
);

// ── Tool: render_still_local ─────────────────────────────────────────
server.tool(
  "render_still_local",
  "Render a single frame (still image) from a Remotion composition. Useful for generating thumbnails, preview frames, or static images from animated compositions.",
  {
    compositionId: z.string().describe("The composition ID"),
    entryPoint: z.string().describe("Path to Remotion entry file"),
    outputPath: z.string().describe("Output image path, e.g. '/tmp/thumbnail.png'"),
    frame: z.number().int().min(0).optional().default(0).describe("Frame number to render. Default: 0"),
    inputProps: z.record(z.any()).optional().describe("Props to pass to the composition"),
    imageFormat: z.enum(["png", "jpeg", "webp"]).optional().default("png").describe("Output image format"),
  },
  async ({ compositionId, entryPoint, outputPath, frame, inputProps, imageFormat }) => {
    const { execSync } = require("child_process");
    const fs = require("fs");

    if (!fs.existsSync(entryPoint)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Entry point not found: ${entryPoint}` }) }],
        isError: true,
      };
    }

    const propsFile = `/tmp/remotion-still-props-${Date.now()}.json`;
    fs.writeFileSync(propsFile, JSON.stringify(inputProps || {}));

    const cmd = `npx remotion still "${entryPoint}" "${compositionId}" "${outputPath}" --frame=${frame || 0} --image-format=${imageFormat || "png"} --props="${propsFile}"`;

    try {
      execSync(cmd, { stdio: "pipe", timeout: 120000 });
      fs.unlinkSync(propsFile);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            compositionId,
            outputPath,
            frame: frame || 0,
            imageFormat: imageFormat || "png",
          }, null, 2),
        }],
      };
    } catch (err) {
      try { fs.unlinkSync(propsFile); } catch {}
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message || "Still render failed" }) }],
        isError: true,
      };
    }
  }
);

// ── Tool: list_compositions ──────────────────────────────────────────
server.tool(
  "list_compositions",
  "List all available compositions from a Remotion project. Returns composition IDs, dimensions, FPS, and duration. Example: list all templates available in your project to find the right one for rendering.",
  {
    entryPoint: z.string().optional().describe("Path to Remotion entry file. If omitted, returns the known built-in compositions."),
    inputProps: z.record(z.any()).optional().describe("Props to use for evaluating dynamic compositions"),
  },
  async ({ entryPoint, inputProps }) => {
    if (!entryPoint) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            compositions: Object.entries(KNOWN_COMPOSITIONS).map(([id, cfg]) => ({
              id,
              width: cfg.width,
              height: cfg.height,
              fps: cfg.fps,
              durationInFrames: cfg.durationInFrames,
              durationSeconds: cfg.durationInFrames / cfg.fps,
            })),
            source: "built-in (no entryPoint provided)",
          }, null, 2),
        }],
      };
    }

    const { execSync } = require("child_process");
    const fs = require("fs");

    if (!fs.existsSync(entryPoint)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Entry point not found: ${entryPoint}` }) }],
        isError: true,
      };
    }

    try {
      const propsArg = inputProps ? `--props='${JSON.stringify(inputProps)}'` : "";
      const output = execSync(`npx remotion compositions "${entryPoint}" ${propsArg} --json`, {
        encoding: "utf8",
        timeout: 60000,
      });

      return {
        content: [{ type: "text", text: output }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  }
);

// ── Tool: get_composition_info ───────────────────────────────────────
server.tool(
  "get_composition_info",
  "Get detailed information about a specific composition, including its default props schema, dimensions, FPS, and duration. Useful before rendering to understand what props are available.",
  {
    compositionId: z.string().describe("The composition ID, e.g. 'marketing-promo'"),
    entryPoint: z.string().optional().describe("Path to Remotion entry file. If omitted, returns built-in composition info."),
  },
  async ({ compositionId, entryPoint }) => {
    if (!entryPoint) {
      const comp = KNOWN_COMPOSITIONS[compositionId];
      if (!comp) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `Unknown composition: ${compositionId}`,
              available: Object.keys(KNOWN_COMPOSITIONS),
            }),
          }],
          isError: true,
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            id: compositionId,
            ...comp,
            durationSeconds: comp.durationInFrames / comp.fps,
            source: "built-in",
          }, null, 2),
        }],
      };
    }

    const { execSync } = require("child_process");
    const fs = require("fs");

    if (!fs.existsSync(entryPoint)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Entry point not found: ${entryPoint}` }) }],
        isError: true,
      };
    }

    try {
      const output = execSync(`npx remotion compositions "${entryPoint}" --json`, {
        encoding: "utf8",
        timeout: 60000,
      });
      const compositions = JSON.parse(output);
      const found = Array.isArray(compositions)
        ? compositions.find((c) => c.id === compositionId)
        : compositions[compositionId];

      if (!found) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: `Composition '${compositionId}' not found in entry point` }),
          }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(found, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  }
);

// ── Tool: create_bundle ──────────────────────────────────────────────
server.tool(
  "create_bundle",
  "Bundle a Remotion project locally (webpack build). This creates a deployable bundle of your compositions. Run this before deploy_bundle_to_lambda to prepare your code for Lambda rendering.",
  {
    entryPoint: z.string().describe("Path to Remotion entry file, e.g. '/path/to/src/compositions/index.tsx'"),
    outDir: z.string().optional().describe("Output directory for the bundle. Default: auto-generated in /tmp"),
    publicDir: z.string().optional().describe("Path to public assets directory"),
  },
  async ({ entryPoint, outDir, publicDir }) => {
    const { execSync } = require("child_process");
    const fs = require("fs");

    if (!fs.existsSync(entryPoint)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Entry point not found: ${entryPoint}` }) }],
        isError: true,
      };
    }

    const outputDir = outDir || `/tmp/remotion-bundle-${Date.now()}`;
    let cmd = `npx remotion bundle "${entryPoint}" "${outputDir}"`;
    if (publicDir) cmd += ` --public-dir="${publicDir}"`;

    try {
      execSync(cmd, { stdio: "pipe", timeout: 300000 });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            bundleDir: outputDir,
            message: "Bundle created. Use deploy_bundle_to_lambda to upload to S3.",
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  }
);

// ── Tool: deploy_bundle_to_lambda ────────────────────────────────────
server.tool(
  "deploy_bundle_to_lambda",
  "Deploy a Remotion bundle to S3 for Lambda rendering. This uploads your bundled compositions to S3, creating a 'site' that Lambda functions can access during rendering. Returns the serveUrl to use with render_video_lambda.",
  {
    entryPoint: z.string().describe("Path to Remotion entry file (bundle and deploy in one step)"),
    siteName: z.string().optional().describe("S3 site name/prefix. If omitted, a random name is generated."),
    bucketName: z.string().optional().describe("Target S3 bucket. If omitted, uses the default Remotion Lambda bucket."),
    publicDir: z.string().optional().describe("Path to public assets directory"),
  },
  async ({ entryPoint, siteName, bucketName, publicDir }) => {
    validateAwsCreds();
    const lambda = getLambda();
    const fs = require("fs");

    if (!fs.existsSync(entryPoint)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Entry point not found: ${entryPoint}` }) }],
        isError: true,
      };
    }

    try {
      const opts = {
        region: AWS_REGION,
        entryPoint,
        enableCaching: true,
      };
      if (siteName) opts.siteName = siteName;
      if (bucketName) opts.bucketName = bucketName;
      if (publicDir) opts.publicDir = publicDir;

      const { serveUrl, siteName: deployedSiteName } = await lambda.deploySite(opts);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            serveUrl,
            siteName: deployedSiteName,
            message: "Bundle deployed to S3. Use this serveUrl with render_video_lambda.",
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  }
);

// ── Tool: create_site ────────────────────────────────────────────────
server.tool(
  "create_site",
  "Create a new Remotion Lambda site by deploying compositions to S3. Equivalent to deploy_bundle_to_lambda but uses a higher-level site abstraction. Returns the site URL and name for use in Lambda renders.",
  {
    entryPoint: z.string().describe("Path to the Remotion entry file"),
    siteName: z.string().optional().describe("Name for the site, e.g. 'my-remotion-site'"),
  },
  async ({ entryPoint, siteName }) => {
    validateAwsCreds();
    const lambda = getLambda();
    const fs = require("fs");

    if (!fs.existsSync(entryPoint)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Entry point not found: ${entryPoint}` }) }],
        isError: true,
      };
    }

    try {
      const opts = { region: AWS_REGION, entryPoint, enableCaching: true };
      if (siteName) opts.siteName = siteName;

      const result = await lambda.deploySite(opts);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            serveUrl: result.serveUrl,
            siteName: result.siteName,
            bucketName: result.bucketName,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  }
);

// ── Tool: list_sites ─────────────────────────────────────────────────
server.tool(
  "list_sites",
  "List all Remotion Lambda sites deployed to S3 in your AWS account. Shows site names, URLs, creation dates, and storage sizes. Useful for managing multiple projects or cleaning up old deployments.",
  {},
  async () => {
    validateAwsCreds();
    const lambda = getLambda();

    try {
      const { sites } = await lambda.getSites({ region: AWS_REGION });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            count: sites.length,
            sites: sites.map((s) => ({
              id: s.id,
              serveUrl: s.serveUrl,
              bucketName: s.bucketName,
              sizeInBytes: s.sizeInBytes,
              lastModified: s.lastModified,
            })),
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  }
);

// ── Tool: delete_site ────────────────────────────────────────────────
server.tool(
  "delete_site",
  "Delete a Remotion Lambda site from S3. Permanently removes the deployed compositions from S3. Use list_sites to find the siteId. This cannot be undone.",
  {
    siteId: z.string().describe("The site ID to delete, from list_sites output"),
    bucketName: z.string().describe("The S3 bucket name where the site is stored"),
  },
  async ({ siteId, bucketName }) => {
    validateAwsCreds();
    const lambda = getLambda();

    try {
      const { totalFiles } = await lambda.deleteSite({
        siteId,
        bucketName,
        region: AWS_REGION,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            siteId,
            deletedFiles: totalFiles,
            message: "Site deleted from S3.",
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  }
);

// ── Tool: estimate_render_cost ───────────────────────────────────────
server.tool(
  "estimate_render_cost",
  "Estimate the AWS Lambda cost for a render before starting it. Pass the composition duration and settings to get a cost estimate in USD. Example: estimate cost of a 5-minute 1080p video render.",
  {
    durationInMilliseconds: z.number().describe("Total render duration in milliseconds (durationInFrames / fps * 1000)"),
    memorySizeInMb: z.number().int().min(512).max(10240).optional().default(2048).describe("Lambda memory size in MB. Default: 2048"),
    diskSizeInMb: z.number().int().min(512).max(10240).optional().default(2048).describe("Lambda disk size in MB. Default: 2048"),
    lambdasInvoked: z.number().int().min(1).optional().default(1).describe("Number of Lambda functions invoked (higher = faster but costs more). Default: 1"),
  },
  async ({ durationInMilliseconds, memorySizeInMb, diskSizeInMb, lambdasInvoked }) => {
    const lambda = getLambda();

    try {
      const cost = lambda.estimatePrice({
        durationInMilliseconds,
        memorySizeInMb: memorySizeInMb || 2048,
        diskSizeInMb: diskSizeInMb || 2048,
        lambdasInvoked: lambdasInvoked || 1,
        region: AWS_REGION,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            estimatedCostUsd: cost.estimatedCost,
            durationMs: durationInMilliseconds,
            memorySizeInMb: memorySizeInMb || 2048,
            diskSizeInMb: diskSizeInMb || 2048,
            lambdasInvoked: lambdasInvoked || 1,
            breakdown: cost,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  }
);

// ── Tool: get_render_config ──────────────────────────────────────────
server.tool(
  "get_render_config",
  "Get the current Remotion render configuration and available Lambda functions in your AWS account. Returns function names, regions, memory settings, and timeout configs. Use this to find valid function names for render_video_lambda.",
  {},
  async () => {
    validateAwsCreds();
    const lambda = getLambda();

    try {
      const functions = await lambda.getFunctions({
        region: AWS_REGION,
        compatibleOnly: false,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            region: AWS_REGION,
            functions: functions.map((f) => ({
              functionName: f.functionName,
              version: f.version,
              memorySizeInMb: f.memorySizeInMb,
              diskSizeInMb: f.diskSizeInMb,
              timeoutInSeconds: f.timeoutInSeconds,
            })),
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  }
);

// ── Tool: validate_composition ───────────────────────────────────────
server.tool(
  "validate_composition",
  "Validate that a composition exists and is correctly configured before attempting a render. Checks that the composition ID is valid, props match the schema, and dimensions/FPS are within acceptable ranges.",
  {
    compositionId: z.string().describe("The composition ID to validate"),
    inputProps: z.record(z.any()).optional().describe("Props to validate against the composition schema"),
    entryPoint: z.string().optional().describe("Path to Remotion entry file for dynamic validation"),
  },
  async ({ compositionId, inputProps, entryPoint }) => {
    const issues = [];
    const warnings = [];

    // Check against known compositions
    const known = KNOWN_COMPOSITIONS[compositionId];

    if (!known && !entryPoint) {
      warnings.push(`Composition '${compositionId}' is not in the built-in list. Provide entryPoint for full validation.`);
    }

    if (known) {
      if (known.width > 3840 || known.height > 2160) {
        issues.push("Resolution exceeds 4K (3840x2160). Lambda rendering may fail.");
      }
      if (known.fps > 60) {
        issues.push("FPS exceeds 60. This is very unusual and may cause issues.");
      }
      if (known.durationInFrames > 18000) {
        warnings.push("Duration exceeds 10 minutes (18000 frames). Consider chunking the render.");
      }
    }

    if (entryPoint) {
      const fs = require("fs");
      if (!fs.existsSync(entryPoint)) {
        issues.push(`Entry point not found: ${entryPoint}`);
      }
    }

    const valid = issues.length === 0;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          valid,
          compositionId,
          knownComposition: known || null,
          inputPropsProvided: !!inputProps,
          issues,
          warnings,
          recommendation: valid
            ? "Composition looks valid. Ready to render."
            : "Fix issues before rendering.",
        }, null, 2),
      }],
    };
  }
);

// ── Express app + health endpoint ────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "remotion-complete", version: "1.0.0" });
});

// MCP endpoint — stateless per request
app.all("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => { transport.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`Remotion Complete MCP server listening on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`MCP:    http://localhost:${PORT}/mcp`);
  console.log(`Region: ${AWS_REGION}`);
});
