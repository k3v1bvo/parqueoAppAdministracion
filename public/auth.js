// auth.js - Manejo de autenticación en el frontend

class Auth {
    constructor() {
        this.token = localStorage.getItem('token');
        this.user = JSON.parse(localStorage.getItem('user') || '{}');
    }

    isAuthenticated() {
        return !!this.token;
    }

    isAdmin() {
        return this.user.rol === 'admin';
    }

    async verifySession() {
        if (!this.token) {
            this.redirectToLogin();
            return false;
        }

        try {
            const res = await fetch('/api/auth/me', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (!res.ok) {
                throw new Error('Sesión inválida');
            }

            const data = await res.json();
            this.user = data.user;
            localStorage.setItem('user', JSON.stringify(data.user));
            return true;
        } catch (error) {
            this.logout();
            return false;
        }
    }

    redirectToLogin() {
        if (window.location.pathname !== '/') {
            window.location.href = '/';
        }
    }

    logout() {
        // Intentar hacer logout en el backend
        if (this.token) {
            fetch('/api/auth/logout', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.token}` }
            }).catch(console.error);
        }
        
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = '/';
    }

    getAuthHeaders() {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
        };
    }
}

// Instancia global de autenticación
const auth = new Auth();

// Proteger rutas que requieren autenticación
const protectedRoutes = ['/dashboard', '/registro', '/ingresos', '/gastos', '/tarifas'];

// Verificar autenticación al cargar la página
document.addEventListener('DOMContentLoaded', async function() {
    const currentPath = window.location.pathname;
    
    // Si está en una ruta protegida, verificar sesión
    if (protectedRoutes.includes(currentPath) || currentPath === '/') {
        const isValid = await auth.verifySession();
        
        if (!isValid && currentPath !== '/') {
            auth.redirectToLogin();
            return;
        }
        
        if (isValid && currentPath === '/') {
            window.location.href = '/dashboard';
            return;
        }
    }
    
    // Actualizar información del usuario en la UI
    const userElements = document.querySelectorAll('#userName');
    userElements.forEach(element => {
        if (auth.user) {
            element.textContent = `${auth.user.nombre} (${auth.user.rol})`;
        }
    });
});

// Función global para logout
window.logout = function() {
    auth.logout();
};

// Interceptor para manejar errores de autenticación
const originalFetch = window.fetch;
window.fetch = async function(...args) {
    try {
        const response = await originalFetch(...args);
        
        if (response.status === 401 || response.status === 403) {
            auth.logout();
            throw new Error('Sesión expirada o inválida');
        }
        
        return response;
    } catch (error) {
        if (error.message.includes('Sesión')) {
            auth.logout();
        }
        throw error;
    }
};

// Exportar para uso global
window.auth = auth;