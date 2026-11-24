const { test, expect } = require('@playwright/test');

test.describe('Pruebas E2E Integrales (Frontend y Backend)', () => {
  test('Backend: GET /api/health responde 200 con estado healthy', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.status).toContain('healthy');
  });

  test('Backend: POST /api/users rechaza email inválido con 400', async ({ request }) => {
    const res = await request.post('/api/users', {
      data: { name: 'Prueba', email: 'correo-sin-arroba' },
    });
    expect(res.status()).toBe(400);
  });

  test('Frontend: carga título, estado de salud y permite registrar un usuario', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('app-title')).toHaveText('Panel DevOps - Usuarios');
    await expect(page.getByTestId('health-status')).toContainText('healthy');

    const uniqueEmail = `e2e_${Date.now()}@uteq.edu.mx`;
    await page.getByTestId('input-name').fill('Andrea E2E');
    await page.getByTestId('input-email').fill(uniqueEmail);
    await page.getByTestId('btn-submit').click();

    await expect(page.getByTestId('form-msg')).toHaveText('Usuario creado correctamente');
    await expect(page.getByTestId('users-list')).toContainText(uniqueEmail);
  });
});