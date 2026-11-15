using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using Debug = UnityEngine.Debug;

namespace NasaSpaceApp.Homeline.Web
{
    /// <summary>An answer of the JSON API: HTTP status and body.</summary>
    internal struct ApiReply
    {
        public int Status;
        public string Json;

        public ApiReply(int status, string json)
        {
            Status = status;
            Json = json;
        }
    }

    /// <summary>
    /// The loopback HTTP server of the web planner: http://127.0.0.1:{port}/ serves the built web app as static files
    /// and a small JSON API under /marvis/api/ (same origin as the page, so no CORS). See README.md in this folder.
    ///
    /// Threads: one listener thread accepts, the thread pool answers. hello, state and eva-log are answered from the
    /// strings below (set by the main thread). POST mission and POST close need Unity: the request waits while
    /// <see cref="Pump"/>, called every frame on the main thread, runs it. No Unity API is used here except Debug.Log.
    /// </summary>
    internal sealed class WebServer
    {
        public const int FirstPort = 47815, LastPort = 47819;
        const int MaxBodyBytes = 4 * 1024 * 1024;
        const int MainThreadTimeoutMs = 10000;
        const string ApiPrefix = "/marvis/api/";

        /// <summary>Bodies of GET hello, GET state and GET eva-log (null = no log yet). Replaced whole by the main thread.</summary>
        public volatile string HelloJson = "{}", StateJson = "{}", EvaLogJson;

        /// <summary>The port in use; 0 when not listening.</summary>
        public int Port { get; private set; }

        sealed class Work
        {
            public string Name, Body;
            public ApiReply Reply;
            public int State;   // 0 queued, 1 taken by the main thread, 2 withdrawn by the waiting request
            public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
        }

        HttpListener listener;
        string root;   // full path of the web root, with a trailing separator
        volatile bool stopping;
        readonly Queue<Work> queue = new Queue<Work>();

        /// <summary>Starts listening on the first free port of 47815..47819. False when none is free.</summary>
        public bool Start(string webRoot)
        {
            root = Path.GetFullPath(webRoot).TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
            for (int port = FirstPort; port <= LastPort; port++)
            {
                var l = new HttpListener();
                try
                {
                    // 127.0.0.1 only: never reachable from the network, and no firewall prompt.
                    l.Prefixes.Add("http://127.0.0.1:" + port + "/");
                    l.Start();
                }
                catch (Exception e)
                {
                    Debug.Log("[WebPlanner] port " + port + " is not available (" + e.Message.Trim() + ")");
                    try
                    {
                        l.Close();
                    }
                    catch (Exception)
                    {
                    }
                    continue;
                }
                listener = l;
                Port = port;
                stopping = false;
                var thread = new Thread(Listen) { IsBackground = true, Name = "WebPlanner HTTP" };
                thread.Start(l);
                return true;
            }
            return false;
        }

        /// <summary>Stops listening, closes the connections and releases the requests still waiting for the main thread.</summary>
        public void Stop()
        {
            HttpListener l = listener;
            if (l == null)
            {
                return;
            }
            lock (queue)
            {
                stopping = true;
                foreach (Work w in queue)
                {
                    w.Reply = new ApiReply(503, Fail("the simulator is closing"));
                    w.Done.Set();
                }
                queue.Clear();
            }
            listener = null;
            Port = 0;
            try
            {
                l.Close();
            }
            catch (Exception)
            {
            }
        }

        /// <summary>Main thread, every frame: runs the queued API calls that need Unity (api name, body) and releases their requests.</summary>
        public void Pump(Func<string, string, ApiReply> handler)
        {
            while (true)
            {
                Work work;
                lock (queue)
                {
                    if (queue.Count == 0)
                    {
                        return;
                    }
                    work = queue.Dequeue();
                }
                if (Interlocked.CompareExchange(ref work.State, 1, 0) != 0)
                {
                    continue;   // its request gave up waiting
                }
                try
                {
                    work.Reply = handler(work.Name, work.Body);
                }
                catch (Exception e)
                {
                    Debug.LogError("[WebPlanner] api " + work.Name + " failed: " + e);
                    work.Reply = new ApiReply(500, Fail("internal error"));
                }
                work.Done.Set();
            }
        }

        // ---------------------------------------------------------------- listener and pool threads

        void Listen(object state)
        {
            var l = (HttpListener)state;
            while (!stopping)
            {
                try
                {
                    HttpListenerContext ctx = l.GetContext();
                    ThreadPool.QueueUserWorkItem(Handle, ctx);
                }
                catch (Exception e)
                {
                    if (stopping)
                    {
                        break;
                    }
                    Debug.LogWarning("[WebPlanner] listener: " + e.Message);
                    Thread.Sleep(100);   // never spin on a persistent error
                }
            }
        }

        void Handle(object state)
        {
            var ctx = (HttpListenerContext)state;
            try
            {
                Uri url = ctx.Request.Url;
                string path = url != null ? url.AbsolutePath : null;
                if (path == null)
                {
                    Text(ctx, 400, "bad request");
                }
                else if (path.StartsWith(ApiPrefix, StringComparison.Ordinal))
                {
                    Api(ctx, path.Substring(ApiPrefix.Length));
                }
                else
                {
                    Static(ctx, path);
                }
            }
            catch (Exception e)
            {
                // A client that goes away mid-answer (page reload, viewer closed) is normal; the rest is worth a line.
                if (!stopping && !(e is IOException) && !(e is HttpListenerException) && !(e is ObjectDisposedException) &&
                    !(e is System.Net.Sockets.SocketException))
                {
                    Debug.LogWarning("[WebPlanner] request failed: " + e);
                }
            }
            finally
            {
                try
                {
                    ctx.Response.Close();
                }
                catch (Exception)
                {
                }
            }
        }

        // ---------------------------------------------------------------- API

        void Api(HttpListenerContext ctx, string name)
        {
            HttpListenerRequest req = ctx.Request;
            bool post = req.HttpMethod == "POST";
            // The body is read before any refusal: answering with it unread resets the connection, and the client
            // sees a network error instead of the status.
            string body = post ? ReadBody(req) : "";
            if (body == null)
            {
                ctx.Response.KeepAlive = false;   // the rest of the body is not read
                Json(ctx, 413, Fail("request body larger than 4 MB"));
                return;
            }
            int port = Port;
            string host = req.Headers["Host"] ?? "";
            if (host != "127.0.0.1:" + port && !host.Equals("localhost:" + port, StringComparison.OrdinalIgnoreCase))
            {
                Json(ctx, 403, Fail("forbidden host"));   // a page of another site reaching us through its own host name
                return;
            }
            if (post && req.Headers["X-Marvis"] != "1")
            {
                Json(ctx, 403, Fail("missing X-Marvis header"));
                return;
            }

            switch (name)
            {
                case "hello":
                case "state":
                case "eva-log":
                    if (req.HttpMethod != "GET")
                    {
                        break;
                    }
                    string json = name == "hello" ? HelloJson : name == "state" ? StateJson : EvaLogJson;
                    if (json == null)
                    {
                        Json(ctx, 404, Fail("no log"));
                    }
                    else
                    {
                        Json(ctx, 200, json);
                    }
                    return;
                case "mission":
                case "close":
                    if (!post)
                    {
                        break;
                    }
                    ApiReply reply = OnMainThread(name, body);
                    Json(ctx, reply.Status, reply.Json);
                    return;
                default:
                    Json(ctx, 404, Fail("unknown api"));
                    return;
            }
            Json(ctx, 405, Fail("method not allowed"));
        }

        // Hands the call to the main thread and waits for its answer.
        ApiReply OnMainThread(string name, string body)
        {
            var work = new Work { Name = name, Body = body };
            lock (queue)
            {
                if (stopping)
                {
                    return new ApiReply(503, Fail("the simulator is closing"));
                }
                queue.Enqueue(work);
            }
            if (!work.Done.Wait(MainThreadTimeoutMs))
            {
                // Not started yet: withdraw it. Already running: give it the time to finish.
                if (Interlocked.CompareExchange(ref work.State, 2, 0) == 0 || !work.Done.Wait(MainThreadTimeoutMs))
                {
                    return new ApiReply(503, Fail("the simulator did not answer in time"));
                }
            }
            return work.Reply;
        }

        // The request body as text (UTF-8); null when it is larger than the limit.
        static string ReadBody(HttpListenerRequest req)
        {
            if (req.ContentLength64 > MaxBodyBytes)
            {
                return null;
            }
            using (var bytes = new MemoryStream())
            {
                var buffer = new byte[16 * 1024];
                Stream input = req.InputStream;
                int n;
                while ((n = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    bytes.Write(buffer, 0, n);
                    if (bytes.Length > MaxBodyBytes)
                    {
                        return null;
                    }
                }
                string text = Encoding.UTF8.GetString(bytes.GetBuffer(), 0, (int)bytes.Length);
                return text.Length > 0 && text[0] == '﻿' ? text.Substring(1) : text;
            }
        }

        // {"ok":false,"error":"..."}; the message is one of this file's plain literals (no escaping needed).
        static string Fail(string message)
        {
            return "{\"ok\":false,\"error\":\"" + message + "\"}";
        }

        static void Json(HttpListenerContext ctx, int status, string json)
        {
            Send(ctx, status, "application/json; charset=utf-8", "no-store", Encoding.UTF8.GetBytes(json));
        }

        static void Text(HttpListenerContext ctx, int status, string text)
        {
            Send(ctx, status, "text/plain; charset=utf-8", "no-store", Encoding.UTF8.GetBytes(text));
        }

        static void Send(HttpListenerContext ctx, int status, string contentType, string cacheControl, byte[] body)
        {
            HttpListenerResponse res = ctx.Response;
            res.StatusCode = status;
            res.ContentType = contentType;
            res.AddHeader("Cache-Control", cacheControl);
            res.ContentLength64 = body.Length;
            if (ctx.Request.HttpMethod != "HEAD")
            {
                res.OutputStream.Write(body, 0, body.Length);
            }
        }

        // ---------------------------------------------------------------- static files

        void Static(HttpListenerContext ctx, string urlPath)
        {
            string method = ctx.Request.HttpMethod;
            bool head = method == "HEAD";
            if (!head && method != "GET")
            {
                Text(ctx, 405, "method not allowed");
                return;
            }
            string file = Resolve(urlPath);
            if (file == null)
            {
                Text(ctx, 404, "not found");
                return;
            }
            string extension = Path.GetExtension(file).ToLowerInvariant();
            HttpListenerResponse res = ctx.Response;
            using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 64 * 1024))
            {
                res.StatusCode = 200;
                res.ContentType = Mime(extension);
                // Only the files under assets/ have a content hash in their name. The rest (index.html, data/) keeps
                // its name when it changes, and the viewer's cache outlives the game: always asked for again.
                res.AddHeader("Cache-Control", urlPath.StartsWith("/assets/", StringComparison.Ordinal) ? "max-age=3600" : "no-cache");
                res.ContentLength64 = stream.Length;
                if (head)
                {
                    return;
                }
                var buffer = new byte[64 * 1024];
                Stream output = res.OutputStream;
                int n;
                while ((n = stream.Read(buffer, 0, buffer.Length)) > 0)
                {
                    output.Write(buffer, 0, n);
                }
            }
        }

        // The file a URL path names inside the web root; null when it is missing, a folder, or outside the root.
        string Resolve(string urlPath)
        {
            try
            {
                string relative = Uri.UnescapeDataString(urlPath).TrimStart('/', '\\');
                if (relative.Length == 0)
                {
                    relative = "index.html";
                }
                if (relative.IndexOf(':') >= 0 || relative.IndexOf('\0') >= 0)
                {
                    return null;   // drive letters, alternate data streams
                }
                string full = Path.GetFullPath(root + relative);   // collapses any ".." left after unescaping
                if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                {
                    return null;
                }
                return File.Exists(full) ? full : null;
            }
            catch (Exception)
            {
                return null;   // not a usable path
            }
        }

        static string Mime(string extension)
        {
            switch (extension)
            {
                case ".html": return "text/html; charset=utf-8";
                case ".js":
                case ".mjs": return "text/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".json":
                case ".geojson": return "application/json";
                case ".webp": return "image/webp";
                case ".png": return "image/png";
                case ".jpg":
                case ".jpeg": return "image/jpeg";
                case ".svg": return "image/svg+xml";
                case ".woff2": return "font/woff2";
                case ".txt": return "text/plain; charset=utf-8";
                default: return "application/octet-stream";   // .gz too: the page inflates it itself, so no Content-Encoding
            }
        }
    }
}
