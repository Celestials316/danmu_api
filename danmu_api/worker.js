    // ==================== 新增辅助函数 START (调试版) ====================
    
    // 1. 获取正确的 API 前缀
    function getApiBaseUrl() {
        let token = '87654321';
        if (typeof AppState !== 'undefined' && AppState.config && AppState.config.TOKEN) {
            token = AppState.config.TOKEN;
        } else {
            const tokenInput = document.getElementById('quickToken');
            if (tokenInput && tokenInput.value) {
                token = tokenInput.value;
            }
        }
        
        console.log('[Debug] 当前使用的 Token:', token);

        // 这里的逻辑需要根据你的服务器实际路由来定
        // 如果你的服务器必须要有 Token 路径，请确保这里返回正确的格式
        if (!token || token === '87654321') {
            return '/api/v2';
        } else {
            return '/' + token + '/api/v2';
        }
    }

    // 2. 安全的 fetch 包装器 (增强日志版)
    async function safeFetch(url, options) {
        options = options || {};
        
        console.log('[Debug] 发起请求:', url);
        console.log('[Debug] 请求参数:', JSON.stringify(options));

        // 确保 GET 请求不带 body，防止某些后端报错
        if (options.method === 'GET' || !options.method) {
            delete options.body;
        }

        try {
            const response = await fetch(url, options);
            const text = await response.text();
            
            console.log('[Debug] 服务器响应状态:', response.status);
            console.log('[Debug] 服务器响应内容:', text.substring(0, 200) + (text.length > 200 ? '...' : ''));

            let data;
            try {
                data = JSON.parse(text);
            } catch (e) {
                // 如果返回的不是 JSON，手动构造错误
                const errorMsg = response.ok ? 
                    '服务器返回了非 JSON 数据 (可能是 HTML 或 纯文本)' : 
                    '请求失败 (' + response.status + '): ' + text;
                throw new Error(errorMsg);
            }
            
            if (!response.ok) {
                // 优先提取后端返回的具体错误信息
                const errorMsg = data.errorMessage || data.message || data.error || 'HTTP ' + response.status + ' 错误';
                throw new Error(errorMsg);
            }
            
            return data;
        } catch (error) {
            console.error('[Debug] Fetch 异常:', error);
            throw error;
        }
    }

    // ==================== 新增辅助函数 END ====================

    // ==================== 核心测试函数 (增强版) ====================
    async function testDanmuByUrl() {
        const input = document.getElementById('danmuTestInput').value.trim();
        if (!input) {
            showToast('请输入番剧名称或视频 URL', 'warning');
            return;
        }

        const apiType = document.getElementById('danmuTestApiType').value;
        const year = document.getElementById('danmuTestYear').value.trim();
        const season = document.getElementById('danmuTestSeason').value.trim();
        const episode = document.getElementById('danmuTestEpisode').value.trim();
        const platform = document.getElementById('danmuTestPlatform').value;

        const previewContainer = document.getElementById('danmuPreviewContainer');
        const matchResultCard = document.getElementById('matchResultCard');
        
        matchResultCard.style.display = 'none';
        
        previewContainer.innerHTML = '<div style="text-align: center; padding: 80px 20px;">' +
            '<span class="loading-spinner" style="width: 48px; height: 48px; border-width: 4px;"></span>' +
            '<div style="margin-top: 24px;">正在请求服务器...</div>' +
            '<div style="margin-top: 8px; font-size: 12px; color: #666;">请按 F12 查看控制台详细日志</div>' +
            '</div>';

        try {
            let apiUrl = '';
            let matchInfo = null;
            const apiBase = getApiBaseUrl(); 
            
            if (input.startsWith('http://') || input.startsWith('https://')) {
                // URL 模式 - 使用 GET
                apiUrl = apiBase + '/comment?url=' + encodeURIComponent(input) + '&format=json';
            } else if (apiType === 'anime') {
                // Anime 模式
                if (!episode) throw new Error('使用 Anime 接口必须指定集数');
                
                showToast('🔍 搜索番剧...', 'info', 1000);
                const searchUrl = apiBase + '/search/anime?keyword=' + encodeURIComponent(input);
                const searchResult = await safeFetch(searchUrl);
                
                if (!searchResult.success || !searchResult.animes || searchResult.animes.length === 0) {
                    throw new Error('未找到番剧');
                }
                const animeId = searchResult.animes[0].animeId;
                
                const bangumiUrl = apiBase + '/bangumi/' + animeId;
                const bangumiResult = await safeFetch(bangumiUrl);
                
                const targetEpisode = bangumiResult.bangumi.episodes.find(function(ep) {
                    return ep.episodeNumber == episode || parseInt(ep.episodeNumber) === parseInt(episode);
                });
                if (!targetEpisode) throw new Error('未找到第 ' + episode + ' 集');
                
                apiUrl = apiBase + '/comment/' + targetEpisode.episodeId + '?format=json';
                
            } else {
                // Match 模式 - 使用 POST
                let searchQuery = input;
                searchQuery = searchQuery.replace(/\.(mkv|mp4|avi|flv|wmv|mov|rmvb|webm)$/i, '').trim();
                
                if (year && !searchQuery.includes(year)) searchQuery += '.' + year;
                if (episode) searchQuery += ' ' + episode.padStart(2, '0');
                else if (season) searchQuery += ' S' + season;
                
                showToast('🔍 正在匹配: ' + searchQuery, 'info', 1000);
                
                // 关键修改：添加 Accept 头，明确告诉服务器我们需要 JSON
                const matchResponse = await safeFetch(apiBase + '/match', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify({ fileName: searchQuery })
                });
                
                if (!matchResponse.isMatched || !matchResponse.matches || matchResponse.matches.length === 0) {
                    throw new Error('未找到匹配结果');
                }
                
                matchInfo = matchResponse.matches[0];
                apiUrl = apiBase + '/comment/' + matchInfo.episodeId + '?format=json';
            }

            // 获取最终弹幕
            showToast('📥 下载弹幕数据...', 'info', 1000);
            const result = await safeFetch(apiUrl);

            let comments = [];
            if (Array.isArray(result)) comments = result;
            else if (result.comments) comments = result.comments;
            else if (result.danmus) comments = result.danmus;

            currentDanmuData = comments;
            filteredDanmuData = [...currentDanmuData];

            if (matchInfo) displayMatchResult(matchInfo);

            if (currentDanmuData.length === 0) {
                previewContainer.innerHTML = '<div style="text-align: center; padding: 80px 20px;"><h3>😢 未找到弹幕</h3></div>';
                document.getElementById('danmuTestCount').textContent = '0 条';
                return;
            }

            displayDanmuList(filteredDanmuData);
            updateDanmuStats();
            showToast('成功获取 ' + currentDanmuData.length + ' 条弹幕', 'success');
            
            document.getElementById('exportJsonBtn').style.display = 'inline-flex';
            document.getElementById('exportXmlBtn').style.display = 'inline-flex';

        } catch (error) {
            console.error('Test Failed:', error);
            let tips = '';
            if (error.message.includes('Invalid JSON body')) {
                tips = '<br><br><strong>💡 提示：</strong> 请检查页面顶部的 <strong>Token</strong> 是否已填写。清理缓存后 Token 会丢失，导致请求路径错误。';
            }
            
            previewContainer.innerHTML = '<div style="text-align: center; padding: 80px 20px; color: #ff4d4f;">' +
                '<div style="font-size: 48px;">❌</div>' +
                '<h3>获取失败</h3>' +
                '<p>' + error.message + '</p>' + 
                '<div style="font-size:12px; color:#888; text-align:left; margin-top:20px; background:#f5f5f5; padding:10px; border-radius:4px;">' +
                '<strong>Debug Info:</strong><br>如果看到 Invalid JSON body，通常是因为:<br>1. Token 丢失导致路径错误<br>2. 服务器发生了重定向(301/302)丢失了请求体' +
                tips + 
                '</div></div>';
            showToast('❌ ' + error.message, 'error');
        }
    }
