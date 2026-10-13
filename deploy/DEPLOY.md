# LiveBridge 正式上线手册

## 0. 需要准备什么

- 一台 24 小时在线的服务器（Linux，如阿里云/腾讯云轻量、VPS），内存 ≥1GB、Node ≥18；
- （可选但推荐）一个域名，解析 A 记录到服务器 IP；
- 服务器上放好：项目文件 + profiles.json（含真实密钥，勿提交到公开仓库）；
- 浏览器麦克风只允许 HTTPS 或 localhost —— **没有 HTTPS，别人的浏览器会直接禁用麦克风**。

## 1. 三种上线方式（选一种）

### 方式 A：云服务器 + Nginx/Caddy（最正规，推荐）

    # 上传项目（可用 scp / rsync / git）到 /opt/livebridge，例如：
    scp -r live-interpreter/* root@你的服务器IP:/opt/livebridge/
    # 服务器上：
    cd /opt/livebridge
    cp profiles.example.json profiles.json   # 然后用 vim/nano 填入真实密钥
    node --version                          # 需 ≥18，没有则先装 Node

    1) 配置 HTTPS（二选一）
       - Caddy（自动证书，最简单）：apt install caddy；复制 deploy/Caddyfile.example
       - Nginx + certbot：apt install nginx certbot python3-certbot-nginx；
         复制 deploy/nginx.conf.example 并改域名后：certbot --nginx -d 你的域名

    2) 开机自启（三选一）：
       - systemd：cp deploy/livebridge.service /etc/systemd/system/ && systemctl enable --now livebridge
       - pm2：npm i -g pm2 && pm2 start server.mjs --name livebridge && pm2 save && pm2 startup
       - Docker：docker build -t livebridge . && docker run -d -p 127.0.0.1:8787:8787 -v /opt/livebridge/profiles.json:/app/profiles.json livebridge

### 方式 B：Docker + 云厂商容器服务（Railway/Render/Fly/腾讯云容器等）

    仓库里有 Dockerfile；平台会托管 TLS，直接绑定域名即可。
    密钥不要写死在镜像里：用平台的环境变量或挂载 profiles.json。
    （当前程序从环境变量 PROFILES_FILE 或 ./profiles.json 读取预设；
     也可给每个用户单独建一个 PROFILES_FILE 指向的配置）

### 方式 C：先免费试试（不买服务器）

    用 Cloudflare Tunnel 或 ngrok 把本机 8787 端口映射成 HTTPS 公网网址：
    - ngrok http 8787           # 得到 https://xxxx.ngrok-free.app（免费版域名随机、本机需开机）
    - 或 frp / tailscale funnel
    适合内部试用/演示，不适合正式对外。

## 2. 上线自检清单

- [ ] https://你的域名 能打开页面（http 会跳 https）
- [ ] 页面上能看到「设置 → 预设代号」里列出你 profiles.json 的代号
- [ ] 点「测试连接（翻译）」显示 ✓
- [ ] 点「测试识别通道」显示 ✓（说明麦克风权限在 HTTPS 下正常）
- [ ] 让朋友用 Chrome/Edge 打开，选代号后开始说话能出中文草稿与译文

## 3. 安全与运维

- profiles.json 含密钥：chmod 600；不要放进 git；.gitignore 已排除；
- 服务只监听 127.0.0.1（systemd 示例已设 HOST=127.0.0.1），公网只暴露 443；
- 防火墙：仅放行 80/443（云控制台安全组 + ufw 都要开）；
- 备份 profiles.json；升级代码前先 cp profiles.json 备份；
- 给不同人群开不同代号（额度/用途分开），改 profiles.json 后重启服务生效；
- 日志：journalctl -u livebridge -f（systemd）或 pm2 logs livebridge；
- 想限制别人自己填 Key：以后可加“锁定模式”，暂未实现（别人仍可手动填）。

## 4. 日常更新

    cd /opt/livebridge
    cp profiles.json profiles.json.bak
    # 上传新代码（server.mjs / public/）
    systemctl restart livebridge     # 或 pm2 restart livebridge
