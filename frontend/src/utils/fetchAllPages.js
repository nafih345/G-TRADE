import axios from 'axios';

// Every row of a paginated DRF list (default PAGE_SIZE 20; every list honours ?page_size=, up to
// each endpoint's max). Reading only `results` of the first response silently dropped everything
// past the first page.
//
// Page 1 says how many rows there are and how big a page the server actually allowed, so the
// remaining pages are requested together rather than one after another — on the hosted backend
// each request is a few hundred milliseconds, and a long list used to cost that many times over.
export const fetchAllPages = async (url, { pageSize = 500, maxPages = 60 } = {}) => {
  const sep = url.includes('?') ? '&' : '?';
  const pageUrl = (page) => `${url}${sep}page=${page}&page_size=${pageSize}`;

  const { data: first } = await axios.get(pageUrl(1));
  if (Array.isArray(first)) return first; // endpoint isn't paginated
  const rows = [...(first?.results || [])];
  if (!first?.next || !rows.length) return rows;

  const perPage = rows.length; // the server may cap page_size below what was asked
  const total = Number(first.count);
  if (!Number.isFinite(total)) {
    // No count to plan with — fall back to following `next` links.
    let next = first.next;
    for (let page = 2; next && page <= maxPages; page += 1) {
      const { data } = await axios.get(next);
      rows.push(...(data?.results || []));
      next = data?.next;
    }
    return rows;
  }

  const lastPage = Math.min(Math.ceil(total / perPage), maxPages);
  const rest = await Promise.all(
    Array.from({ length: lastPage - 1 }, (_, i) => axios.get(pageUrl(i + 2)).then((r) => r.data?.results || []))
  );
  rest.forEach((pageRows) => rows.push(...pageRows));
  return rows;
};
