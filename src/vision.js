/**
 * 图片识别模块（Vision / Image Caption）
 * 将 QQ 消息中的图片转换为文字描述，注入 AI 对话上下文
 */

import fs from 'fs';

export class VisionClient {
    constructor(config) {
        this.config = config || {};
    }

    updateConfig(newConfig) {
        if (newConfig) Object.assign(this.config, newConfig);
    }

    isEnabled() {
        return this.config.enabled === true && !!this.getApiUrl();
    }

    getApiUrl() {
        if (this.config.baseUrl) {
            return `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
        }
        return this.config.apiUrl || null;
    }

    /**
     * 获取图片描述的主入口
     * @param {string} source - 图片来源：http(s) URL / base64://xxx / file:///path 或绝对路径
     * @param {Function} [resolveUrl] - 可选的 URL 解析器（如通过 OneBot get_image API）
     * @returns {Promise<string>} 图片的文字描述
     */
    async describe(source, resolveUrl = null) {
        const dataUrl = await this.toDataUrl(source, resolveUrl);
        if (!dataUrl) {
            throw new Error('无法获取图片数据');
        }
        return this.caption(dataUrl);
    }

    /**
     * 将各种来源统一转换为 base64 data URL（自动归一化不支持的格式）
     */
    async toDataUrl(source, resolveUrl = null) {
        try {
            let buf = null;

            if (source.startsWith('base64://')) {
                buf = Buffer.from(source.slice('base64://'.length), 'base64');
            } else {
                let url = source;

                // file:// 或本地绝对路径
                if (url.startsWith('file://') || url.startsWith('/')) {
                    const realPath = url.startsWith('file://')
                        ? decodeURIComponent(url.slice('file://'.length))
                        : url;
                    buf = fs.readFileSync(realPath);
                } else {
                    // 无有效 URL 时，尝试通过外部解析器（OneBot get_image）获取
                    if (!/^https?:\/\//.test(url)) {
                        if (resolveUrl) {
                            const resolved = await resolveUrl(url);
                            if (resolved) url = resolved;
                        }
                        if (!/^https?:\/\//.test(url)) {
                            return null;
                        }
                    }

                    // 下载网络图片（带超时和大小限制）
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), 20000);
                    const resp = await fetch(url, { signal: controller.signal });
                    clearTimeout(timer);

                    if (!resp.ok) {
                        throw new Error(`图片下载失败: HTTP ${resp.status}`);
                    }

                    buf = Buffer.from(await resp.arrayBuffer());
                }
            }

            if (!buf || buf.length === 0) {
                throw new Error('图片内容为空');
            }
            if (buf.length > 10 * 1024 * 1024) {
                throw new Error('图片过大（超过 10MB）');
            }

            // 格式归一化：GIF/BMP/TIFF 等转成 PNG
            const normalized = await this.normalizeImage(buf);
            return `data:${normalized.mime};base64,${normalized.buf.toString('base64')}`;
        } catch (err) {
            console.error(`[Vision] 图片转换失败: ${err.message}`);
            return null;
        }
    }

    /**
     * 通过文件头嗅探图片真实格式
     */
    detectMime(buf) {
        if (buf.length < 12) return 'application/octet-stream';
        const head = buf.subarray(0, 12);
        if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
        if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
        if (head.subarray(0, 3).toString() === 'GIF') return 'image/gif';
        if (head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
        if (head[0] === 0x42 && head[1] === 0x4d) return 'image/bmp';
        if ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a) ||
            (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00)) return 'image/tiff';
        if (head.subarray(4, 8).toString() === 'ftyp') return 'image/heic';
        return 'application/octet-stream';
    }

    /**
     * 格式归一化：Gemini 不支持 gif/bmp/tiff，用 sharp 转成 PNG（GIF 取第一帧）
     */
    async normalizeImage(buf) {
        const mime = this.detectMime(buf);
        const supported = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];

        if (supported.includes(mime)) {
            return { buf, mime };
        }

        // 未知格式但看起来像图片的，也尝试交给 sharp 解码
        try {
            const sharp = (await import('sharp')).default;
            const out = await sharp(buf, { animated: false, pages: 1 })
                .png()
                .toBuffer();
            console.error(`[Vision] 已将 ${mime} 转换为 PNG (${buf.length}B -> ${out.length}B)`);
            return { buf: out, mime: 'image/png' };
        } catch (err) {
            // sharp 不可用或无法解码：png/jpeg 嗅探直接放行，其余抛错
            if (mime === 'image/png' || mime === 'image/jpeg') {
                return { buf, mime };
            }
            throw new Error(`不支持的图片格式 ${mime}，转换失败: ${err.message}`);
        }
    }

    /**
     * 调用视觉模型生成图片描述
     */
    async caption(dataUrl) {
        const apiUrl = this.getApiUrl();
        if (!apiUrl) {
            throw new Error('未配置视觉 API URL');
        }

        const headers = { 'Content-Type': 'application/json' };
        if (this.config.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }

        const body = {
            model: this.config.model || 'gemini-2.0-flash',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: this.config.prompt || '用中文详细描述这张图片的内容。' },
                        { type: 'image_url', image_url: { url: dataUrl } }
                    ]
                }
            ],
            max_tokens: this.config.maxTokens || 1024,
            temperature: this.config.temperature ?? 0.3,
            stream: false
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 45000);
        try {
            const resp = await fetch(apiUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal
            });

            if (!resp.ok) {
                const errorText = await resp.text();
                throw new Error(`视觉 API 错误: ${resp.status} - ${errorText.substring(0, 200)}`);
            }

            const data = await resp.json();
            const content = data.choices?.[0]?.message?.content;
            if (!content || !content.trim()) {
                throw new Error('视觉模型返回空内容');
            }
            return content.trim();
        } finally {
            clearTimeout(timer);
        }
    }
}
