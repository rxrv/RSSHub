import { Route } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';
import { getRandom16, decryptUrl } from './utils';
const baseUrl = 'https://www.ximalaya.com';
import { config } from '@/config';
import { parseDate } from '@/utils/parse-date';
import { Album, RichIntro, TrackInfoResponse } from './types';
import sanitizeHtml from 'sanitize-html';

// Find category from: https://help.apple.com/itc/podcasts_connect/?lang=en#/itc9267a2f12
const categoryDict = {
    人文: 'Society & Culture',
    历史: 'History',
    头条: 'News',
    娱乐: 'Leisure',
    音乐: 'Music',
    IT科技: 'Technology',
};

function getAlbumData(albumId) {
    return cache.tryGet(`ximalaya:albumInfo:${albumId}`, async () => {
        const response = await ofetch(`${baseUrl}/revision/album/v1/simple`, {
            query: {
                albumId,
            },
            parseResponse: JSON.parse,
        });
        return response.data.albumPageMainInfo as Album;
    });
}

function judgeTrue(str, ...validStrings) {
    if (!str) {
        return false;
    }
    str = str.toLowerCase();
    if (str === 'true' || str === '1') {
        return true;
    }
    for (const _s of validStrings) {
        if (str === _s) {
            return true;
        }
    }
    return false;
}

export const route: Route = {
    path: ['/:type/:id/:all/:shownote?'],
    categories: ['multimedia'],
    example: '/ximalaya/album/299146',
    parameters: {
        type: '专辑类型, 通常可以使用 `album`，可在对应专辑页面的 URL 中找到',
        id: '专辑 id, 可在对应专辑页面的 URL 中找到',
        all: '是否需要获取全部节目，填入 `1`、`true`、`all` 视为获取所有节目，填入其他则不获取。',
    },
    features: {
        requireConfig: [
            {
                name: 'XIMALAYA_TOKEN',
                description: '',
            },
        ],
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: true,
        supportScihub: false,
    },
    name: '专辑',
    maintainers: ['lengthmin', 'jjeejj', 'prnake'],
    handler,
    description: `目前喜马拉雅的 API 只能一集一集的获取各节目上的 ShowNote，会极大的占用系统资源，所以默认为不获取节目的 ShowNote。

::: warning
  专辑类型即 url 中的分类拼音，使用通用分类 \`album\` 通常是可行的，专辑 id 是跟在**分类拼音**后的那个 id, 不要输成某集的 id 了

  **付费内容需要配置好已购买账户的 token 才能收听，详情见部署页面的配置模块**
:::`,
};

async function handler(ctx) {
    const type = ctx.req.param('type'); // 专辑分类
    const id = ctx.req.param('id'); // 专辑id
    const shouldAll = judgeTrue(ctx.req.param('all'), 'all');
    const shouldShowNote = judgeTrue(ctx.req.param('shownote'), 'shownote');
    const pageSize = shouldAll ? 200 : 30;

    const albumData = await getAlbumData(id);

    const isPaid = albumData.isPaid;

    const author = albumData.anchorName;

    const albumTitle = albumData.albumTitle; // 专辑标题
    const albumCover = 'https:' + albumData.cover;
    const albumIntro = sanitizeHtml(albumData.detailRichIntro, { allowedTags: [], allowedAttributes: {} }); // 专辑介绍

    const albumCategory = albumData.categoryTitle; // 专辑分类名字

    // sort 为 1 时是降序
    // const isAsc = albumData.store.AlbumDetailTrackList.sort === 0;
    // 喜马拉雅的 API 的 query 参数 isAsc=0 时才是升序，不写就是降序。
    const trackInfoApi = `https://mobile.ximalaya.com/mobile/v1/album/track/?albumId=${id}&pageSize=${pageSize}&pageId=`;
    const trackInfoResponse = await ofetch<TrackInfoResponse>(trackInfoApi + '1', {
        parseResponse: JSON.parse,
    });
    const maxPageId = trackInfoResponse.data.maxPageId; // 最大页数

    let playList = trackInfoResponse.data.list;

    if (shouldAll) {
        const promises = [];
        for (let i = 2; i <= maxPageId; i++) {
            // string + number -> string
            promises.push(
                ofetch<TrackInfoResponse>(trackInfoApi + i, {
                    parseResponse: JSON.parse,
                })
            );
        }
        const responses = await Promise.all(promises);
        for (const j of responses) {
            playList = [...playList, ...j.data.list];
        }
    }

    await Promise.all(
        playList.map(async (item) => {
            item.desc = await cache.tryGet(`ximalaya:trackRichInfo:${item.trackId}:${shouldShowNote.toString()}`, async () => {
                let _desc: string = '';
                if (shouldShowNote) {
                    const trackRichInfoApi = `https://mobile.ximalaya.com/mobile-track/richIntro?trackId=${item.trackId}`;
                    const trackRichInfoResponse = await ofetch<RichIntro>(trackRichInfoApi);
                    _desc = trackRichInfoResponse.richIntro;
                }
                if (!_desc) {
                    _desc = item.intro;
                }
                return _desc;
            });
        })
    );

    const token = config.ximalaya.token;
    if (isPaid && token) {
        const randomToken = getRandom16(8) + '-' + getRandom16(4) + '-' + getRandom16(4) + '-' + getRandom16(4) + '-' + getRandom16(12);
        await Promise.all(
            playList.map(async (item) => {
                const timestamp = Math.floor(Date.now());
                const trackPayInfoApi = `https://www.ximalaya.com/mobile-playpage/track/v3/baseInfo/${timestamp}?device=www2&trackQualityLevel=2&trackId=${item.trackId}`;
                const data = await cache.tryGet('ximalaya:trackPayInfo' + trackPayInfoApi, async () => {
                    const trackPayInfoResponse = await ofetch(trackPayInfoApi, {
                        headers: {
                            'user-agent': 'ting_6.7.9(GM1900,Android29)',
                            cookie: `1&_device=android&${randomToken}&6.7.9;1&_token=${token}`,
                        },
                    });
                    const trackInfo = trackPayInfoResponse.trackInfo;
                    const _item = {};
                    if (!trackInfo.isAuthorized) {
                        return _item;
                    }
                    _item.playPathAacv224 = decryptUrl(trackInfo.playUrlList[0].url);
                    return _item;
                });

                if (data.playPathAacv224) {
                    item.playPathAacv224 = data.playPathAacv224;
                }
                if (data.desc) {
                    item.desc = data.desc;
                }
            })
        );
    }

    const resultItems = playList.map((item) => {
        const title = item.title;
        const trackId = item.trackId;
        const itunesItemImage = item.coverLarge.split('!')[0] ?? albumCover;
        const link = `${baseUrl}/sound/${trackId}`;
        const pubDate = parseDate(item.createdAt, 'x');
        const duration = item.duration; // 时间长度：单位（秒）
        const enclosureUrl = item.playPathAacv224 || item.playPathAacv164;

        let resultItem = {
            title,
            link,
            description: item.desc || '',
            pubDate,
            itunes_item_image: itunesItemImage,
        };

        if (enclosureUrl) {
            if (isPaid) {
                resultItem.description = '[该内容需付费] ' + resultItem.description;
            }
            resultItem = {
                ...resultItem,
                enclosure_url: enclosureUrl,
                itunes_duration: duration,
                enclosure_type: 'audio/x-m4a',
            };
        } else {
            resultItem.description = '[该内容需付费] ' + resultItem.description;
        }

        return resultItem;
    });

    return {
        title: albumTitle,
        link: `${baseUrl}/${type}/${id}`,
        description: albumIntro,
        image: albumCover,
        itunes_author: author,
        itunes_category: categoryDict[albumCategory] || albumCategory,
        item: resultItems,
    };
}
