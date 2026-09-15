import axios from 'axios';

// Every row of a paginated DRF list (settings: PageNumberPagination, PAGE_SIZE 20). Reading only
// `results` of the first response silently dropped everything past the first page. Endpoints that
// honour ?page_size= (the Sales lists) come back in a few large pages; others just take more pages.
export const fetchAllPages = async (url, { pageSize = 500, maxPages = 60 } = {}) => {
  const sep = url.includes('?') ? '&' : '?';
  const rows = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const { data } = await axios.get(`${url}${sep}page=${page}&page_size=${pageSize}`);
    if (Array.isArray(data)) return data; // endpoint isn't paginated
    rows.push(...(data?.results || []));
    if (!data?.next) break;
  }
  return rows;
};
