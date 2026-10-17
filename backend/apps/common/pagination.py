from rest_framework.pagination import PageNumberPagination


class PageSizePagination(PageNumberPagination):
    """The site default (settings PAGE_SIZE = 20) unless the client asks for more with
    ?page_size= (up to 1000).

    Plain PageNumberPagination ignores ?page_size=, so screens that read a whole list
    (utils/fetchAllPages.js asks for 500 a page) were walking it 20 rows per request, one
    request after another — each a few hundred milliseconds on the hosted stack."""
    page_size_query_param = 'page_size'
    max_page_size = 1000
