interface HealthResponse {
  readonly status: 'ok';
  readonly service: 'name-that-team-member';
}

export const onRequestGet: PagesFunction = () => {
  const body: HealthResponse = {
    status: 'ok',
    service: 'name-that-team-member',
  };

  return Response.json(body, {
    headers: {
      'cache-control': 'no-store',
    },
  });
};
